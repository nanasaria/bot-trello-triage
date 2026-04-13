import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { TrelloService } from '../trello/trello.service.js';
import { ClaudeService } from '../claude/claude.service.js';
import type { TrelloAction, TrelloAttachment } from '../trello/trello.types.js';

@Injectable()
export class TriageService implements OnModuleInit {
  private readonly logger = new Logger(TriageService.name);

  private readonly processedActionIds = new Map<string, true>();
  private readonly PROCESSED_IDS_MAX = 1000;
  private readonly processedCardIds = new Set<string>();
  private readonly TRIAGE_DELAY_MS = 150_000;

  private readonly jobQueue: TrelloAction[] = [];
  private isProcessing = false;

  private readonly repoLabelMap: Record<string, string>;
  private readonly defaultRepoPath: string;

  constructor(
    private readonly trelloService: TrelloService,
    private readonly claudeService: ClaudeService,
    private readonly config: ConfigService,
  ) {
    this.repoLabelMap = this.parseRepoLabelMap();
    this.defaultRepoPath = this.config.get<string>('DEFAULT_REPO_PATH', '');
  }

  onModuleInit(): void {
    const enabled = this.config.get<string>('STARTUP_SCAN', 'true') !== 'false';
    if (!enabled) {
      this.logger.log('Scan inicial desabilitado (STARTUP_SCAN=false)');
      return;
    }
    void this.scanUntriaged();
  }

  enqueue(action: TrelloAction): void {
    this.jobQueue.push(action);
    this.drainQueue();
  }

  private async scanUntriaged(): Promise<void> {
    try {
      const listIds = await this.trelloService.getTargetListIds();
      for (const listId of listIds) {
        const cards = await this.trelloService.fetchCardsInList(listId);
        this.logger.log(
          `Scan: ${cards.length} card(s) encontrado(s) na lista ${listId}`,
        );
        for (const card of cards) {
          if (this.processedCardIds.has(card.id)) {
            this.logger.debug(
              `Card ${card.id} já triado nesta sessão, ignorando`,
            );
            continue;
          }
          const alreadyTriaged = await this.trelloService.hasTriageComment(
            card.id,
          );
          if (alreadyTriaged) {
            this.processedCardIds.add(card.id);
          } else {
            this.logger.log(
              `Scan: card sem triagem — ${card.id} "${card.name}"`,
            );
            await this.processTriageForCard(card.id, { skipDelay: true });
          }
        }
      }
      this.logger.log('Scan concluído');
    } catch (err) {
      this.logger.error(
        `Scan falhou: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  private drainQueue(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const processNext = async () => {
      const action = this.jobQueue.shift();
      if (!action) {
        this.isProcessing = false;
        return;
      }
      try {
        await this.handleAction(action);
      } catch (err) {
        this.logger.error(
          `Erro não capturado ao processar job da fila: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
      void processNext();
    };

    void processNext();
  }

  private async handleAction(action: TrelloAction): Promise<void> {
    const { id: actionId, type } = action;

    this.logger.debug(
      `Ação recebida: type=${type} cardId=${action.data.card?.id} listId=${action.data.list?.id ?? action.data.listAfter?.id ?? 'n/a'}`,
    );

    if (this.processedActionIds.has(actionId)) {
      this.logger.debug(`ActionId ${actionId} já processado, ignorando`);
      return;
    }

    const cardId = action.data.card?.id;
    const triggeredListId = this.extractTargetListId(action);

    if (!cardId || !triggeredListId) {
      return;
    }

    let targetListIds: string[];
    try {
      targetListIds = await this.trelloService.getTargetListIds();
    } catch (err) {
      this.logger.error('Não foi possível resolver as listas alvo', err);
      return;
    }

    if (!targetListIds.includes(triggeredListId)) {
      this.logger.debug(
        `Ação ${type} na lista ${triggeredListId} ignorada (alvos: ${targetListIds.join(', ')})`,
      );
      return;
    }

    this.logger.log(
      `Ação relevante detectada: type=${type} cardId=${cardId} actionId=${actionId}`,
    );

    this.trackActionId(actionId);

    if (type === 'updateCard') {
      this.logger.log(
        `Card ${cardId} movido para a lista alvo — iniciando scan completo`,
      );
      await this.scanUntriaged();
    } else {
      try {
        await this.processTriageForCard(cardId);
      } catch (err) {
        this.processedActionIds.delete(actionId);
        this.logger.error(
          `Triagem falhou para o card ${cardId}: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }
  }

  private async processTriageForCard(
    cardId: string,
    opts: { skipDelay?: boolean } = {},
  ): Promise<void> {
    if (this.processedCardIds.has(cardId)) {
      this.logger.log(`Card ${cardId} já triado nesta sessão, ignorando`);
      return;
    }

    if (!opts.skipDelay) {
      this.logger.log(
        `Card ${cardId} aguardando ${this.TRIAGE_DELAY_MS / 1000}s antes de iniciar a triagem...`,
      );
      await new Promise((resolve) => setTimeout(resolve, this.TRIAGE_DELAY_MS));
    }

    const alreadyTriaged = await this.trelloService.hasTriageComment(cardId);
    if (alreadyTriaged) {
      this.logger.log(
        `Card ${cardId} já possui comentário de triagem, ignorando`,
      );
      this.processedCardIds.add(cardId);
      return;
    }

    const card = await this.trelloService.fetchCard(cardId);
    const comments = await this.trelloService.fetchRecentComments(cardId, 5);

    const repoPath = this.resolveRepoPath(card.labels.map((l) => l.name));
    if (!repoPath) {
      this.logger.warn(
        `Card ${cardId} sem label repo:* e DEFAULT_REPO_PATH não configurado. Abortando triagem.`,
      );
      return;
    }
    this.logger.log(`Repositório selecionado: ${repoPath}`);

    const { imagePaths, spreadsheetTexts, documentTexts, cleanup } =
      await this.downloadCardAttachments(cardId);

    try {
      this.logger.log(`Iniciando análise do Claude para o card "${card.name}"`);
      const result = await this.claudeService.runTriage(
        card,
        comments,
        repoPath,
        imagePaths,
        spreadsheetTexts,
        documentTexts,
      );

      const commentText = this.formatTriageComment(result);
      await this.trelloService.postComment(cardId, commentText);
      this.processedCardIds.add(cardId);

      this.logger.log(
        `Triagem concluída e comentário publicado no card ${cardId}`,
      );
    } finally {
      await cleanup();
    }
  }

  private extractTargetListId(action: TrelloAction): string | null {
    switch (action.type) {
      case 'createCard':
      case 'copyCard':
      case 'moveCardToBoard':
        return action.data.list?.id ?? null;

      case 'updateCard':
        return action.data.listAfter?.id ?? null;

      default:
        return null;
    }
  }

  private trackActionId(actionId: string): void {
    if (this.processedActionIds.size >= this.PROCESSED_IDS_MAX) {
      const oldest = this.processedActionIds.keys().next().value as string;
      this.processedActionIds.delete(oldest);
    }
    this.processedActionIds.set(actionId, true);
  }

  private resolveRepoPath(labelNames: string[]): string | null {
    for (const label of labelNames) {
      if (label.startsWith('repo:') && this.repoLabelMap[label]) {
        return this.repoLabelMap[label];
      }
    }

    return this.defaultRepoPath || null;
  }

  private formatTriageComment(result: {
    hipoteseInicial: string;
    arquivosCandidatos: string[];
    proximosPassosSugeridos: string[];
  }): string {
    const arquivos =
      result.arquivosCandidatos.length > 0
        ? result.arquivosCandidatos.map((f) => `- ${f}`).join('\n')
        : '- Nenhum arquivo específico identificado na triagem inicial';

    const passos = result.proximosPassosSugeridos
      .map((p, i) => `${i + 1}. ${p}`)
      .join('\n');

    return [
      '[Análise técnica automática]',
      '',
      'Hipótese inicial:',
      result.hipoteseInicial,
      '',
      'Arquivos candidatos:',
      arquivos,
      '',
      'Próximos passos sugeridos:',
      passos,
    ].join('\n');
  }

  private async downloadCardAttachments(cardId: string): Promise<{
    imagePaths: string[];
    spreadsheetTexts: string[];
    documentTexts: string[];
    cleanup: () => Promise<void>;
  }> {
    const emptyResult = {
      imagePaths: [],
      spreadsheetTexts: [],
      documentTexts: [],
      cleanup: async () => {},
    };

    let images: TrelloAttachment[];
    let spreadsheets: TrelloAttachment[];
    let documents: TrelloAttachment[];
    let videos: TrelloAttachment[];
    try {
      ({ images, spreadsheets, documents, videos } =
        await this.trelloService.fetchAttachments(cardId));
    } catch (err) {
      this.logger.warn(
        `Falha ao buscar anexos do card ${cardId}: ${(err as Error).message}`,
      );
      return emptyResult;
    }

    const needsTmpDir = images.length > 0 || videos.length > 0;
    const tmpDir = needsTmpDir
      ? await mkdtemp(join(tmpdir(), `triage-${cardId}-`))
      : null;

    const imagePaths: string[] = [];
    if (tmpDir && images.length > 0) {
      for (const att of images) {
        try {
          const filePath = await this.trelloService.downloadAttachmentToDir(
            att,
            tmpDir,
          );
          imagePaths.push(filePath);
          this.logger.debug(`Imagem baixada: ${att.name} → ${filePath}`);
        } catch (err) {
          this.logger.warn(
            `Falha ao baixar imagem "${att.name}": ${(err as Error).message}`,
          );
        }
      }
    }

    if (tmpDir && videos.length > 0) {
      for (const att of videos) {
        try {
          const videoPath = await this.trelloService.downloadAttachmentToDir(
            att,
            tmpDir,
          );
          const frames = await this.extractVideoFrames(
            videoPath,
            tmpDir,
            att.name,
          );
          imagePaths.push(...frames);
          this.logger.debug(
            `${frames.length} frame(s) extraído(s) de "${att.name}"`,
          );
        } catch (err) {
          this.logger.warn(
            `Falha ao processar vídeo "${att.name}": ${(err as Error).message}`,
          );
        }
      }
    }

    const spreadsheetTexts: string[] = [];
    if (spreadsheets.length > 0) {
      for (const att of spreadsheets) {
        try {
          const text = await this.trelloService.downloadSpreadsheetAsText(att);
          spreadsheetTexts.push(`## Planilha: ${att.name}\n\n${text}`);
          this.logger.debug(`Planilha convertida: ${att.name}`);
        } catch (err) {
          this.logger.warn(
            `Falha ao converter planilha "${att.name}": ${(err as Error).message}`,
          );
        }
      }
    }

    const documentTexts: string[] = [];
    if (documents.length > 0) {
      for (const att of documents) {
        try {
          const text = await this.trelloService.downloadWordDocumentAsText(att);
          documentTexts.push(`## Documento: ${att.name}\n\n${text}`);
          this.logger.debug(`Documento convertido: ${att.name}`);
        } catch (err) {
          this.logger.warn(
            `Falha ao converter documento "${att.name}": ${(err as Error).message}`,
          );
        }
      }
    }

    const cleanup = async () => {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true });
        this.logger.debug(`Diretório temporário removido: ${tmpDir}`);
      }
    };

    return { imagePaths, spreadsheetTexts, documentTexts, cleanup };
  }

  private async extractVideoFrames(
    videoPath: string,
    destDir: string,
    videoName: string,
  ): Promise<string[]> {
    const framesDir = join(destDir, `frames_${Date.now()}`);
    await execFileAsync('mkdir', ['-p', framesDir]);

    await execFileAsync('ffmpeg', [
      '-i',
      videoPath,
      '-vf',
      'fps=1/10',
      '-frames:v',
      '10',
      join(framesDir, 'frame_%03d.png'),
    ]);

    const files = await readdir(framesDir);
    const framePaths = files
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => join(framesDir, f));

    if (framePaths.length === 0) {
      this.logger.warn(`Nenhum frame extraído do vídeo "${videoName}"`);
    }

    return framePaths;
  }

  private parseRepoLabelMap(): Record<string, string> {
    const raw = this.config.get<string>('REPO_LABEL_MAP', '{}');
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error('REPO_LABEL_MAP deve ser um objeto JSON');
      }
      return parsed as Record<string, string>;
    } catch (err) {
      this.logger.error(
        `Falha ao parsear REPO_LABEL_MAP: ${(err as Error).message}. Usando mapa vazio.`,
      );
      return {};
    }
  }
}
