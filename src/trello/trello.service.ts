import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import type {
  TrelloAction,
  TrelloAttachment,
  TrelloCard,
  TrelloComment,
  TrelloList,
} from './trello.types.js';

@Injectable()
export class TrelloService implements OnModuleInit {
  private readonly logger = new Logger(TrelloService.name);

  private readonly key: string;
  private readonly token: string;
  private readonly boardId: string;
  private readonly baseUrl = 'https://api.trello.com/1';

  private readonly defaultTargetListPrefixes = [
    'Pendentes Analise - Chamados',
    'Lotes',
  ];
  private readonly defaultCountedListPrefixes = [
    'Pendentes Analise - Chamados',
    'Lotes',
    'Em tratativa com Devs',
    'Pendente publicar',
    'Pendentes Resposta Tia Tati/Tia Regi',
  ];

  private targetListIds: string[] = [];
  private countedListIds: string[] = [];

  private listCountSyncPending = false;
  private isSyncingListCounts = false;

  constructor(private readonly config: ConfigService) {
    this.key = this.config.getOrThrow<string>('TRELLO_KEY');
    this.token = this.config.getOrThrow<string>('TRELLO_TOKEN');
    this.boardId = this.config.getOrThrow<string>('TRELLO_BOARD_ID');
  }

  async onModuleInit(): Promise<void> {
    try {
      this.targetListIds = await this.resolveTargetListIds();
      this.logger.log(
        `Listas de triagem resolvidas: ${this.targetListIds.join(', ')}`,
      );
    } catch (err) {
      this.logger.error(
        'Falha ao resolver listas de triagem na inicialização',
        err,
      );
    }

    try {
      this.countedListIds = await this.resolveCountedListIds();
      this.logger.log(
        `Listas com contador resolvidas: ${this.countedListIds.join(', ')}`,
      );
      await this.refreshCountedLists();
    } catch (err) {
      this.logger.error(
        'Falha ao resolver listas com contador na inicialização',
        err,
      );
    }

    await this.ensureWebhookRegistered();
  }

  async getTargetListIds(): Promise<string[]> {
    if (this.targetListIds.length > 0) return this.targetListIds;
    this.targetListIds = await this.resolveTargetListIds();
    return this.targetListIds;
  }

  scheduleListCountSync(action: TrelloAction): void {
    if (!this.shouldSyncListCounts(action)) {
      return;
    }

    this.listCountSyncPending = true;

    if (this.isSyncingListCounts) {
      return;
    }

    void this.flushListCountSyncQueue();
  }

  private async flushListCountSyncQueue(): Promise<void> {
    this.isSyncingListCounts = true;

    try {
      while (this.listCountSyncPending) {
        this.listCountSyncPending = false;
        await this.refreshCountedLists();
      }
    } catch (err) {
      this.logger.error(
        `Falha ao sincronizar contadores das listas: ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      this.isSyncingListCounts = false;
    }
  }

  private async refreshCountedLists(): Promise<void> {
    const countedListIds = await this.getCountedListIds();
    if (countedListIds.length === 0) {
      return;
    }

    const boardLists = await this.fetchBoardLists('all');
    const listsById = new Map(boardLists.map((list) => [list.id, list]));

    for (const listId of countedListIds) {
      const currentList = listsById.get(listId);

      if (!currentList) {
        this.logger.warn(`Lista monitorada ${listId} não encontrada no board`);
        continue;
      }

      if (currentList.closed) {
        this.logger.debug(
          `Lista ${currentList.name} está arquivada; contador não será atualizado`,
        );
        continue;
      }

      const cards = await this.fetchCardsInList(listId);
      const nextName = this.buildCountedListName(
        currentList.name,
        cards.length,
      );

      if (currentList.name === nextName) {
        this.logger.debug(
          `Lista ${currentList.name} já está com contador atualizado`,
        );
        continue;
      }

      await this.updateListName(listId, nextName);
      this.logger.log(
        `Lista atualizada: "${currentList.name}" -> "${nextName}"`,
      );
    }
  }

  private async getCountedListIds(): Promise<string[]> {
    if (this.countedListIds.length > 0) return this.countedListIds;
    this.countedListIds = await this.resolveCountedListIds();
    return this.countedListIds;
  }

  private async resolveTargetListIds(): Promise<string[]> {
    const explicit = this.config.get<string>('TRELLO_TARGET_LIST_ID');
    if (explicit?.trim()) {
      this.logger.log(
        `Usando TRELLO_TARGET_LIST_ID explícito: ${explicit.trim()}`,
      );
      return [explicit.trim()];
    }

    const prefixes = this.getConfiguredPrefixes(
      'TRELLO_TARGET_LIST_PREFIXES',
      this.defaultTargetListPrefixes,
      'TRELLO_TARGET_LIST_PREFIX',
    );

    const lists = await this.resolveListsByPrefixes(prefixes);
    return lists.map((list) => list.id);
  }

  private async resolveCountedListIds(): Promise<string[]> {
    const prefixes = this.getConfiguredPrefixes(
      'TRELLO_COUNTED_LIST_PREFIXES',
      this.defaultCountedListPrefixes,
    );

    const lists = await this.resolveListsByPrefixes(prefixes);
    return lists.map((list) => list.id);
  }

  private getConfiguredPrefixes(
    configKey: string,
    defaultPrefixes: string[],
    legacyConfigKey?: string,
  ): string[] {
    const raw =
      this.config.get<string>(configKey, '') ||
      (legacyConfigKey ? this.config.get<string>(legacyConfigKey, '') : '') ||
      defaultPrefixes.join(',');

    return raw
      .split(',')
      .map((prefix) => prefix.trim())
      .filter(Boolean);
  }

  private async resolveListsByPrefixes(
    prefixes: string[],
  ): Promise<TrelloList[]> {
    const lists = await this.fetchBoardLists();
    const matches: TrelloList[] = [];

    for (const prefix of prefixes) {
      const normalizedPrefix = this.normalizeName(prefix);
      const match = lists.find(
        (list) =>
          !list.closed &&
          this.normalizeName(list.name).startsWith(normalizedPrefix),
      );

      if (match) {
        this.logger.log(`Lista encontrada: "${match.name}" (id: ${match.id})`);
        matches.push(match);
        continue;
      }

      this.logger.warn(
        `Nenhuma lista encontrada com prefixo "${prefix}". ` +
          `Listas disponíveis: ${lists.map((list) => list.name).join(', ')}`,
      );
    }

    if (matches.length === 0) {
      throw new Error(
        `Nenhuma lista encontrada. Listas disponíveis: ${lists.map((list) => list.name).join(', ')}`,
      );
    }

    return matches;
  }

  private normalizeName(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s*\(\d+\)\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private stripCountSuffix(name: string): string {
    return name.replace(/\s*\(\d+\)\s*$/, '').trim();
  }

  private extractCountPadding(name: string): number | null {
    const match = name.match(/\((\d+)\)\s*$/);
    return match ? match[1].length : null;
  }

  private buildCountedListName(currentName: string, count: number): string {
    const baseName = this.stripCountSuffix(currentName);
    const padding = this.extractCountPadding(currentName);
    const formattedCount =
      padding && padding > 0
        ? String(count).padStart(padding, '0')
        : String(count);

    return `${baseName} (${formattedCount})`;
  }

  private shouldSyncListCounts(action: TrelloAction): boolean {
    switch (action.type) {
      case 'createCard':
      case 'copyCard':
      case 'deleteCard':
      case 'moveCardFromBoard':
      case 'moveCardToBoard':
        return true;

      case 'updateCard':
        return this.isListCountRelevantUpdate(action);

      default:
        return false;
    }
  }

  private isListCountRelevantUpdate(action: TrelloAction): boolean {
    return Boolean(
      action.data.listBefore ||
      action.data.listAfter ||
      action.data.old?.idList !== undefined ||
      action.data.old?.closed !== undefined,
    );
  }

  private async fetchBoardLists(
    filter: 'open' | 'all' = 'open',
  ): Promise<TrelloList[]> {
    const url = this.buildUrl(`/boards/${this.boardId}/lists`, { filter });
    const res = await fetch(url);
    await this.assertOk(res, 'buscar listas do board');
    return res.json() as Promise<TrelloList[]>;
  }

  async fetchCardsInList(listId: string): Promise<TrelloCard[]> {
    const url = this.buildUrl(`/lists/${listId}/cards`, {
      fields: 'id,name,desc,idList,labels,closed',
    });
    const res = await fetch(url);
    await this.assertOk(res, `buscar cards da lista ${listId}`);
    const cards = (await res.json()) as TrelloCard[];
    return cards.filter((card) => !card.closed);
  }

  async fetchCard(cardId: string): Promise<TrelloCard> {
    const url = this.buildUrl(`/cards/${cardId}`, {
      checklists: 'all',
      fields: 'name,desc,idList,labels',
    });
    const res = await fetch(url);
    await this.assertOk(res, `buscar card ${cardId}`);
    return res.json() as Promise<TrelloCard>;
  }

  async fetchRecentComments(
    cardId: string,
    limit = 5,
  ): Promise<TrelloComment[]> {
    const url = this.buildUrl(`/cards/${cardId}/actions`, {
      filter: 'commentCard',
      limit: String(limit),
    });
    const res = await fetch(url);
    await this.assertOk(res, `buscar comentários do card ${cardId}`);
    return res.json() as Promise<TrelloComment[]>;
  }

  async fetchAttachments(cardId: string): Promise<{
    images: TrelloAttachment[];
    spreadsheets: TrelloAttachment[];
    documents: TrelloAttachment[];
    videos: TrelloAttachment[];
  }> {
    const url = this.buildUrl(`/cards/${cardId}/attachments`);
    const res = await fetch(url);
    await this.assertOk(res, `buscar anexos do card ${cardId}`);
    const attachments = (await res.json()) as TrelloAttachment[];

    return {
      images: attachments.filter((attachment) =>
        attachment.mimeType?.startsWith('image/'),
      ),
      spreadsheets: attachments.filter((attachment) =>
        this.isSpreadsheet(attachment),
      ),
      documents: attachments.filter((attachment) =>
        this.isWordDocument(attachment),
      ),
      videos: attachments.filter((attachment) => this.isVideo(attachment)),
    };
  }

  private isSpreadsheet(attachment: TrelloAttachment): boolean {
    const spreadsheetMimes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'application/csv',
    ];
    if (spreadsheetMimes.includes(attachment.mimeType)) return true;

    const ext = extname(attachment.name).toLowerCase();
    return ['.xlsx', '.xls', '.csv'].includes(ext);
  }

  private isWordDocument(attachment: TrelloAttachment): boolean {
    const wordMimes = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ];
    if (wordMimes.includes(attachment.mimeType)) return true;

    const ext = extname(attachment.name).toLowerCase();
    return ['.docx', '.doc'].includes(ext);
  }

  private isVideo(attachment: TrelloAttachment): boolean {
    if (attachment.mimeType?.startsWith('video/')) return true;

    const ext = extname(attachment.name).toLowerCase();
    return ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext);
  }

  async downloadAttachmentToDir(
    attachment: TrelloAttachment,
    destDir: string,
  ): Promise<string> {
    const res = await fetch(attachment.url, {
      headers: {
        Authorization: `OAuth oauth_consumer_key="${this.key}", oauth_token="${this.token}"`,
      },
    });
    await this.assertOk(res, `baixar anexo "${attachment.name}"`);

    const buffer = await res.arrayBuffer();
    const ext = extname(attachment.name) || '.png';
    const filename = `${attachment.id}${ext}`;
    const filepath = join(destDir, filename);

    await writeFile(filepath, Buffer.from(buffer));
    return filepath;
  }

  async downloadSpreadsheetAsText(
    attachment: TrelloAttachment,
  ): Promise<string> {
    const res = await fetch(attachment.url, {
      headers: {
        Authorization: `OAuth oauth_consumer_key="${this.key}", oauth_token="${this.token}"`,
      },
    });
    await this.assertOk(res, `baixar planilha "${attachment.name}"`);

    const buffer = await res.arrayBuffer();
    const workbook = XLSX.read(Buffer.from(buffer));

    const sheets = workbook.SheetNames.map((sheetName) => {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      return `### Aba: ${sheetName}\n${csv}`;
    });

    return sheets.join('\n\n');
  }

  async downloadWordDocumentAsText(
    attachment: TrelloAttachment,
  ): Promise<string> {
    const res = await fetch(attachment.url, {
      headers: {
        Authorization: `OAuth oauth_consumer_key="${this.key}", oauth_token="${this.token}"`,
      },
    });
    await this.assertOk(res, `baixar documento "${attachment.name}"`);

    const buffer = Buffer.from(await res.arrayBuffer());
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  async hasTriageComment(cardId: string): Promise<boolean> {
    const comments = await this.fetchRecentComments(cardId, 20);
    return comments.some((comment) =>
      comment.data.text.startsWith('[Análise técnica automática]'),
    );
  }

  async postComment(cardId: string, text: string): Promise<void> {
    const url = this.buildUrl(`/cards/${cardId}/actions/comments`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await this.assertOk(res, `publicar comentário no card ${cardId}`);
    this.logger.log(`Comentário publicado no card ${cardId}`);
  }

  private async updateListName(listId: string, name: string): Promise<void> {
    const url = this.buildUrl(`/lists/${listId}`, { name });
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Accept: 'application/json' },
    });
    await this.assertOk(res, `atualizar nome da lista ${listId}`);
  }

  private async ensureWebhookRegistered(): Promise<void> {
    const callbackUrl = this.config.get<string>(
      'TRELLO_WEBHOOK_CALLBACK_URL',
      '',
    );
    if (!callbackUrl) {
      this.logger.warn(
        'TRELLO_WEBHOOK_CALLBACK_URL não configurado — webhook não será registrado',
      );
      return;
    }

    try {
      const listUrl = `${this.baseUrl}/tokens/${this.token}/webhooks?key=${this.key}&token=${this.token}`;
      const listRes = await fetch(listUrl);
      await this.assertOk(listRes, 'listar webhooks do token');
      const webhooks = (await listRes.json()) as Array<{
        callbackURL: string;
        idModel: string;
        active: boolean;
      }>;

      const alreadyRegistered = webhooks.some(
        (webhook) =>
          webhook.callbackURL === callbackUrl &&
          webhook.idModel === this.boardId,
      );

      if (alreadyRegistered) {
        this.logger.log('Webhook já registrado no Trello');
        return;
      }

      const createUrl = `${this.baseUrl}/webhooks?key=${this.key}&token=${this.token}`;
      const createRes = await fetch(createUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callbackURL: callbackUrl,
          idModel: this.boardId,
          description: 'bot-triagem-trello',
        }),
      });
      await this.assertOk(createRes, 'registrar webhook');
      this.logger.log(`Webhook registrado com sucesso: ${callbackUrl}`);
    } catch (err) {
      this.logger.error(
        `Falha ao registrar webhook: ${(err as Error).message}`,
      );
    }
  }

  private buildUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('key', this.key);
    url.searchParams.set('token', this.token);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private async assertOk(res: Response, operation: string): Promise<void> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Trello API erro ao ${operation}: HTTP ${res.status} — ${body}`,
      );
    }
  }
}
