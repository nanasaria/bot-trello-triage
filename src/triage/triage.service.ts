import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TrelloService } from '../trello/trello.service.js';
import { ClaudeService } from '../claude/claude.service.js';
import type { TrelloAction, TrelloAttachment } from '../trello/trello.types.js';

@Injectable()
export class TriageService {
  private readonly logger = new Logger(TriageService.name);

  private readonly processedActionIds = new Map<string, true>();
  private readonly PROCESSED_IDS_MAX = 1000;
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

  enqueue(action: TrelloAction): void {
    this.jobQueue.push(action);
    this.drainQueue();
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
      processNext();
    };

    processNext();
  }

  private async handleAction(action: TrelloAction): Promise<void> {
    const { id: actionId, type } = action;

    if (this.processedActionIds.has(actionId)) {
      this.logger.debug(`ActionId ${actionId} já processado, ignorando`);
      return;
    }

    const cardId = action.data.card?.id;
    const triggeredListId = this.extractTargetListId(action);

    if (!cardId || !triggeredListId) {
      return;
    }

    let targetListId: string;
    try {
      targetListId = await this.trelloService.getTargetListId();
    } catch (err) {
      this.logger.error('Não foi possível resolver a lista alvo', err);
      return;
    }

    if (triggeredListId !== targetListId) {
      this.logger.debug(
        `Ação ${type} na lista ${triggeredListId} ignorada (alvo: ${targetListId})`,
      );
      return;
    }

    this.logger.log(
      `Ação relevante detectada: type=${type} cardId=${cardId} actionId=${actionId}`,
    );

    this.trackActionId(actionId);

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

  private async processTriageForCard(cardId: string): Promise<void> {
    this.logger.log(
      `Card ${cardId} aguardando ${this.TRIAGE_DELAY_MS / 1000}s antes de iniciar a triagem...`,
    );
    await new Promise((resolve) => setTimeout(resolve, this.TRIAGE_DELAY_MS));

    const alreadyTriaged = await this.trelloService.hasTriageComment(cardId);
    if (alreadyTriaged) {
      this.logger.log(
        `Card ${cardId} já possui comentário de triagem, ignorando`,
      );
      return;
    }

    this.logger.log(`Buscando dados do card ${cardId}`);
    const card = await this.trelloService.fetchCard(cardId);

    const comments = await this.trelloService.fetchRecentComments(cardId, 5);
    this.logger.log(
      `Card "${card.name}" — ${comments.length} comentário(s) encontrado(s)`,
    );

    const repoPath = this.resolveRepoPath(card.labels.map((l) => l.name));
    if (!repoPath) {
      this.logger.warn(
        `Card ${cardId} sem label repo:* e DEFAULT_REPO_PATH não configurado. Abortando triagem.`,
      );
      return;
    }
    this.logger.log(`Repositório selecionado: ${repoPath}`);

    const { imagePaths, spreadsheetTexts, cleanup } =
      await this.downloadCardAttachments(cardId);

    try {
      this.logger.log(`Iniciando análise do Claude para o card "${card.name}"`);
      const result = await this.claudeService.runTriage(
        card,
        comments,
        repoPath,
        imagePaths,
        spreadsheetTexts,
      );

      const commentText = this.formatTriageComment(result);
      await this.trelloService.postComment(cardId, commentText);

      this.logger.log(
        `Triagem concluída e comentário publicado no card ${cardId}`,
      );
    } finally {
      await cleanup();
    }
  }

  private extractTargetListId(action: TrelloAction): string | null {
    if (action.type === 'createCard') {
      return action.data.list?.id ?? null;
    }

    if (action.type === 'updateCard' && action.data.listAfter) {
      return action.data.listAfter.id;
    }

    return null;
  }

  private trackActionId(actionId: string): void {
    if (this.processedActionIds.size >= this.PROCESSED_IDS_MAX) {
      const oldest = this.processedActionIds.keys().next().value;
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
    cleanup: () => Promise<void>;
  }> {
    const emptyResult = {
      imagePaths: [],
      spreadsheetTexts: [],
      cleanup: async () => {},
    };

    let images: TrelloAttachment[];
    let spreadsheets: TrelloAttachment[];
    try {
      ({ images, spreadsheets } =
        await this.trelloService.fetchAttachments(cardId));
    } catch (err) {
      this.logger.warn(
        `Falha ao buscar anexos do card ${cardId}: ${(err as Error).message}`,
      );
      return emptyResult;
    }

    const tmpDir =
      images.length > 0
        ? await mkdtemp(join(tmpdir(), `triage-${cardId}-`))
        : null;

    const imagePaths: string[] = [];
    if (tmpDir) {
      this.logger.log(
        `${images.length} imagem(ns) encontrada(s) no card ${cardId}`,
      );
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

    const spreadsheetTexts: string[] = [];
    if (spreadsheets.length > 0) {
      this.logger.log(
        `${spreadsheets.length} planilha(s) encontrada(s) no card ${cardId}`,
      );
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

    const cleanup = async () => {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true });
        this.logger.debug(`Diretório temporário removido: ${tmpDir}`);
      }
    };

    return { imagePaths, spreadsheetTexts, cleanup };
  }

  private parseRepoLabelMap(): Record<string, string> {
    const raw = this.config.get<string>('REPO_LABEL_MAP', '{}');
    try {
      const parsed = JSON.parse(raw);
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
