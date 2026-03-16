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

  // LRU cache para deduplicação em memória de actionIds já processados.
  // Usa Map (ordem de inserção garantida) com limite de 1000 entradas para evitar
  // crescimento ilimitado. Quando cheio, remove a entrada mais antiga antes de inserir.
  private readonly processedActionIds = new Map<string, true>();
  private readonly PROCESSED_IDS_MAX = 1000;

  // Fila in-memory: permite bufferizar ações recebidas e processá-las uma a uma.
  // Evita chamadas simultâneas ao Claude CLI e garante que nenhum evento seja
  // descartado enquanto outro ainda está sendo processado.
  // Limitação conhecida: jobs pendentes são perdidos se o processo reiniciar.
  private readonly jobQueue: TrelloAction[] = [];
  private isProcessing = false;

  // Mapeamento de label -> caminho do repositório, parseado do env na inicialização
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

  // Ponto de entrada público: enfileira a ação e retorna imediatamente.
  // O controller chama este método — não handleAction diretamente.
  enqueue(action: TrelloAction): void {
    this.jobQueue.push(action);
    this.drainQueue();
  }

  // Drena a fila sequencialmente. Se já estiver processando, retorna sem fazer nada —
  // o loop em andamento continuará consumindo os jobs adicionados.
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

  // Processa uma ação do webhook. Chamado internamente pela fila.
  private async handleAction(action: TrelloAction): Promise<void> {
    const { id: actionId, type } = action;

    // 1. Deduplicação rápida em memória
    if (this.processedActionIds.has(actionId)) {
      this.logger.debug(`ActionId ${actionId} já processado, ignorando`);
      return;
    }

    // 2. Filtra apenas ações relevantes
    const cardId = action.data.card?.id;
    const triggeredListId = this.extractTargetListId(action);

    if (!cardId || !triggeredListId) {
      // Ação não é createCard nem movimentação de card — ignora silenciosamente
      return;
    }

    // 3. Verifica se a lista do evento corresponde à lista alvo
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

    // Marca como processado ANTES de iniciar o trabalho pesado para evitar
    // processamento duplo em caso de retry do webhook durante o processamento
    this.trackActionId(actionId);

    try {
      await this.processTriageForCard(cardId);
    } catch (err) {
      // Remove do cache em caso de falha para permitir reprocessamento futuro
      this.processedActionIds.delete(actionId);
      this.logger.error(`Triagem falhou para o card ${cardId}: ${(err as Error).message}`, (err as Error).stack);
    }
  }

  // Executa todo o fluxo de triagem para um card específico
  private async processTriageForCard(cardId: string): Promise<void> {
    // 1. Aguarda 1 minuto antes de iniciar a análise para garantir que a descrição
    //    e mídias anexadas ao card já estejam completamente carregadas no Trello
    const delayMs = 210_000; // 3 minutos e 30 segundos
    this.logger.log(`Card ${cardId} aguardando ${delayMs / 1000}s antes de iniciar a triagem...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    // 2. Verifica se o card já tem comentário de triagem (deduplicação persistente)
    const alreadyTriaged = await this.trelloService.hasTriageComment(cardId);
    if (alreadyTriaged) {
      this.logger.log(`Card ${cardId} já possui comentário de triagem, ignorando`);
      return;
    }

    // 3. Busca dados completos do card (com checklists)
    this.logger.log(`Buscando dados do card ${cardId}`);
    const card = await this.trelloService.fetchCard(cardId);

    // 5. Busca comentários recentes (últimos 5)
    const comments = await this.trelloService.fetchRecentComments(cardId, 5);
    this.logger.log(`Card "${card.name}" — ${comments.length} comentário(s) encontrado(s)`);

    // 6. Determina o repositório a analisar com base nas labels do card
    const repoPath = this.resolveRepoPath(card.labels.map((l) => l.name));
    if (!repoPath) {
      this.logger.warn(
        `Card ${cardId} sem label repo:* e DEFAULT_REPO_PATH não configurado. Abortando triagem.`,
      );
      return;
    }
    this.logger.log(`Repositório selecionado: ${repoPath}`);

    // 7. Baixa imagens e lê planilhas anexadas ao card
    const { imagePaths, spreadsheetTexts, cleanup } = await this.downloadCardAttachments(cardId);

    // 8. Executa a triagem via Claude CLI; cleanup roda sempre, com ou sem erro
    try {
      this.logger.log(`Iniciando análise do Claude para o card "${card.name}"`);
      const result = await this.claudeService.runTriage(card, comments, repoPath, imagePaths, spreadsheetTexts);

      // 9. Monta e publica o comentário no Trello
      const commentText = this.formatTriageComment(result);
      await this.trelloService.postComment(cardId, commentText);

      this.logger.log(`Triagem concluída e comentário publicado no card ${cardId}`);
    } finally {
      await cleanup();
    }
  }

  // Extrai o ID da lista relevante dependendo do tipo da ação:
  // - createCard: lista onde o card foi criado
  // - updateCard com listAfter: lista para onde o card foi movido
  // Retorna null para outros tipos de ação
  private extractTargetListId(action: TrelloAction): string | null {
    if (action.type === 'createCard') {
      return action.data.list?.id ?? null;
    }

    if (action.type === 'updateCard' && action.data.listAfter) {
      return action.data.listAfter.id;
    }

    return null;
  }

  // Registra um actionId no cache LRU. Quando o limite é atingido, remove
  // a entrada mais antiga (primeira chave do Map, que é a mais antiga por inserção).
  private trackActionId(actionId: string): void {
    if (this.processedActionIds.size >= this.PROCESSED_IDS_MAX) {
      const oldest = this.processedActionIds.keys().next().value;
      this.processedActionIds.delete(oldest);
    }
    this.processedActionIds.set(actionId, true);
  }

  // Determina o caminho do repositório com base nas labels do card.
  // Prioridade: primeira label no formato "repo:<nome>" encontrada no mapeamento.
  // Fallback: DEFAULT_REPO_PATH.
  private resolveRepoPath(labelNames: string[]): string | null {
    for (const label of labelNames) {
      if (label.startsWith('repo:') && this.repoLabelMap[label]) {
        return this.repoLabelMap[label];
      }
    }

    return this.defaultRepoPath || null;
  }

  // Monta o comentário final no formato exigido
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

  // Busca todos os anexos do card, baixa imagens para diretório temporário e
  // converte planilhas para texto. Retorna tudo junto com função de cleanup.
  private async downloadCardAttachments(cardId: string): Promise<{
    imagePaths: string[];
    spreadsheetTexts: string[];
    cleanup: () => Promise<void>;
  }> {
    const empty = { imagePaths: [], spreadsheetTexts: [], cleanup: async () => {} };

    let images: TrelloAttachment[];
    let spreadsheets: TrelloAttachment[];
    try {
      ({ images, spreadsheets } = await this.trelloService.fetchAttachments(cardId));
    } catch (err) {
      this.logger.warn(`Falha ao buscar anexos do card ${cardId}: ${(err as Error).message}`);
      return empty;
    }

    // --- Imagens: baixar para tmp dir ---
    const tmpDir = images.length > 0
      ? await mkdtemp(join(tmpdir(), `triage-${cardId}-`))
      : null;

    const imagePaths: string[] = [];
    if (tmpDir) {
      this.logger.log(`${images.length} imagem(ns) encontrada(s) no card ${cardId}`);
      for (const att of images) {
        try {
          const filePath = await this.trelloService.downloadAttachmentToDir(att, tmpDir);
          imagePaths.push(filePath);
          this.logger.debug(`Imagem baixada: ${att.name} → ${filePath}`);
        } catch (err) {
          this.logger.warn(`Falha ao baixar imagem "${att.name}": ${(err as Error).message}`);
        }
      }
    }

    // --- Planilhas: baixar e converter para texto ---
    const spreadsheetTexts: string[] = [];
    if (spreadsheets.length > 0) {
      this.logger.log(`${spreadsheets.length} planilha(s) encontrada(s) no card ${cardId}`);
      for (const att of spreadsheets) {
        try {
          const text = await this.trelloService.downloadSpreadsheetAsText(att);
          spreadsheetTexts.push(`## Planilha: ${att.name}\n\n${text}`);
          this.logger.debug(`Planilha convertida: ${att.name}`);
        } catch (err) {
          this.logger.warn(`Falha ao converter planilha "${att.name}": ${(err as Error).message}`);
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

  // Parseia REPO_LABEL_MAP do env como JSON.
  // Exemplo: {"repo:notro-api":"/home/user/projetos/notro-api"}
  private parseRepoLabelMap(): Record<string, string> {
    const raw = this.config.get<string>('REPO_LABEL_MAP', '{}');
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
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
