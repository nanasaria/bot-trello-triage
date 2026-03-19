import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import type {
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

  private targetListId: string | null = null;

  constructor(private readonly config: ConfigService) {
    this.key = this.config.getOrThrow<string>('TRELLO_KEY');
    this.token = this.config.getOrThrow<string>('TRELLO_TOKEN');
    this.boardId = this.config.getOrThrow<string>('TRELLO_BOARD_ID');
  }

  async onModuleInit(): Promise<void> {
    try {
      this.targetListId = await this.resolveTargetListId();
      this.logger.log(`Lista alvo resolvida: ${this.targetListId}`);
    } catch (err) {
      this.logger.error('Falha ao resolver lista alvo na inicialização', err);
    }

    await this.ensureWebhookRegistered();
  }

  async getTargetListId(): Promise<string> {
    if (this.targetListId) return this.targetListId;
    this.targetListId = await this.resolveTargetListId();
    return this.targetListId;
  }

  private async resolveTargetListId(): Promise<string> {
    const explicit = this.config.get<string>('TRELLO_TARGET_LIST_ID');
    if (explicit?.trim()) {
      this.logger.log(`Usando TRELLO_TARGET_LIST_ID explícito: ${explicit.trim()}`);
      return explicit.trim();
    }

    const prefix = this.config.get<string>(
      'TRELLO_TARGET_LIST_PREFIX',
      'Pendentes Analise - Chamados',
    );
    const normalizedPrefix = this.normalizeName(prefix);
    this.logger.log(`Buscando lista por prefixo normalizado: "${normalizedPrefix}"`);

    const lists = await this.fetchBoardLists();
    const match = lists.find(
      (l) => !l.closed && this.normalizeName(l.name).startsWith(normalizedPrefix),
    );

    if (!match) {
      throw new Error(
        `Nenhuma lista encontrada no board com prefixo "${prefix}". ` +
          `Listas disponíveis: ${lists.map((l) => l.name).join(', ')}`,
      );
    }

    this.logger.log(`Lista alvo encontrada: "${match.name}" (id: ${match.id})`);
    return match.id;
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

  private async fetchBoardLists(): Promise<TrelloList[]> {
    const url = this.buildUrl(`/boards/${this.boardId}/lists`, { filter: 'open' });
    const res = await fetch(url);
    await this.assertOk(res, 'buscar listas do board');
    return res.json() as Promise<TrelloList[]>;
  }

  async fetchCardsInList(listId: string): Promise<TrelloCard[]> {
    const url = this.buildUrl(`/lists/${listId}/cards`, {
      fields: 'id,name,desc,idList,labels',
    });
    const res = await fetch(url);
    await this.assertOk(res, `buscar cards da lista ${listId}`);
    return res.json() as Promise<TrelloCard[]>;
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

  async fetchRecentComments(cardId: string, limit = 5): Promise<TrelloComment[]> {
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
      images: attachments.filter((a) => a.mimeType?.startsWith('image/')),
      spreadsheets: attachments.filter((a) => this.isSpreadsheet(a)),
      documents: attachments.filter((a) => this.isWordDocument(a)),
      videos: attachments.filter((a) => this.isVideo(a)),
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

  async downloadSpreadsheetAsText(attachment: TrelloAttachment): Promise<string> {
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

  async downloadWordDocumentAsText(attachment: TrelloAttachment): Promise<string> {
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
    return comments.some((c) => c.data.text.startsWith('[Análise técnica automática]'));
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

  private async ensureWebhookRegistered(): Promise<void> {
    const callbackUrl = this.config.get<string>('TRELLO_WEBHOOK_CALLBACK_URL', '');
    if (!callbackUrl) {
      this.logger.warn('TRELLO_WEBHOOK_CALLBACK_URL não configurado — webhook não será registrado');
      return;
    }

    try {
      const listUrl = `${this.baseUrl}/tokens/${this.token}/webhooks?key=${this.key}&token=${this.token}`;
      const listRes = await fetch(listUrl);
      await this.assertOk(listRes, 'listar webhooks do token');
      const webhooks = (await listRes.json()) as Array<{ callbackURL: string; idModel: string; active: boolean }>;

      const alreadyRegistered = webhooks.some(
        (w) => w.callbackURL === callbackUrl && w.idModel === this.boardId,
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
      this.logger.error(`Falha ao registrar webhook: ${(err as Error).message}`);
    }
  }

  private buildUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('key', this.key);
    url.searchParams.set('token', this.token);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  private async assertOk(res: Response, operation: string): Promise<void> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Trello API erro ao ${operation}: HTTP ${res.status} — ${body}`);
    }
  }
}
