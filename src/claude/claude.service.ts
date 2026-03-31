import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import type { TrelloCard, TrelloComment } from '../trello/trello.types.js';

export interface ClaudeTriageResult {
  hipoteseInicial: string;
  arquivosCandidatos: string[];
  proximosPassosSugeridos: string[];
}

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);

  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly MAX_ATTACHMENT_CHARS = 80_000;

  private readonly claudeBin: string;
  private readonly claudeModel: string;
  private readonly claudeMaxTurns: number;

  constructor(private readonly config: ConfigService) {
    this.claudeBin = this.config.get<string>('CLAUDE_BIN', 'claude');
    this.claudeModel = this.config.get<string>('CLAUDE_MODEL', 'sonnet');
    this.claudeMaxTurns = parseInt(
      this.config.get<string>('CLAUDE_MAX_TURNS', '6'),
      10,
    );
  }

  async runTriage(
    card: TrelloCard,
    comments: TrelloComment[],
    repoPath: string,
    imagePaths: string[] = [],
    spreadsheetTexts: string[] = [],
    documentTexts: string[] = [],
  ): Promise<ClaudeTriageResult> {
    const prompt = this.buildPrompt(card, comments, imagePaths, spreadsheetTexts, documentTexts);
    this.logger.log(`Executando Claude CLI em: ${repoPath}`);
    this.logger.debug(`Prompt montado (${prompt.length} chars)`);

    return this.runWithRetry(prompt, repoPath);
  }

  private async runWithRetry(
    prompt: string,
    repoPath: string,
  ): Promise<ClaudeTriageResult> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const rawOutput = await this.spawnClaude(prompt, repoPath);
        return this.parseAndValidate(rawOutput);
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(
          `Claude CLI falhou (tentativa ${attempt}/${this.MAX_RETRY_ATTEMPTS}): ${lastError.message}`,
        );

        if (attempt < this.MAX_RETRY_ATTEMPTS) {
          const delayMs = 15_000 * attempt;
          this.logger.log(`Aguardando ${delayMs / 1000}s antes de retentar...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    throw new Error(
      `Claude CLI falhou após ${this.MAX_RETRY_ATTEMPTS} tentativas. Último erro: ${lastError?.message}`,
    );
  }

  private buildPrompt(
    card: TrelloCard,
    comments: TrelloComment[],
    imagePaths: string[],
    spreadsheetTexts: string[],
    documentTexts: string[],
  ): string {
    const checklistSection = this.formatChecklists(card.checklists ?? []);
    const commentsSection = this.formatComments(comments);
    const imagesSection = this.formatImagePaths(imagePaths);
    const spreadsheetsSection = this.formatSpreadsheets(spreadsheetTexts);
    const documentsSection = this.formatDocuments(documentTexts);

    return `Você é um engenheiro de software sênior realizando triagem técnica de chamados.

Analise o chamado abaixo e o código-fonte disponível no repositório local (diretório de trabalho atual).
Seu objetivo é levantar uma hipótese técnica inicial, identificar os arquivos mais relevantes para investigação e sugerir próximos passos.

## Chamado

**Título:** ${card.name}

**Descrição:**
${card.desc?.trim() || 'Sem descrição informada.'}

**Checklists:**
${checklistSection}

**Comentários recentes:**
${commentsSection}

**Imagens anexadas ao card:**
${imagesSection}

**Planilhas anexadas ao card:**
${spreadsheetsSection}

**Documentos anexados ao card:**
${documentsSection}

## Instruções obrigatórias

- NÃO proponha a solução final neste momento. Faça APENAS a triagem inicial.
- NÃO invente certezas. Indique hipóteses baseadas no código e no chamado.
- Se não encontrar arquivos específicos, liste os mais prováveis com base no contexto.
- Responda em português do Brasil.
- Sua resposta deve ser SOMENTE um JSON válido. Sem texto antes, sem texto depois, sem blocos markdown, sem explicações fora do JSON.

## Formato obrigatório da resposta

Responda SOMENTE com este JSON (sem nenhum texto fora do objeto):

{
  "hipoteseInicial": "descrição da hipótese técnica inicial",
  "arquivosCandidatos": ["caminho/arquivo1.ts", "caminho/arquivo2.ts"],
  "proximosPassosSugeridos": ["passo 1", "passo 2", "passo 3"]
}`;
  }

  private formatChecklists(
    checklists: NonNullable<TrelloCard['checklists']>,
  ): string {
    if (checklists.length === 0) return 'Nenhum checklist.';

    return checklists
      .map((cl) => {
        const items = cl.checkItems
          .map((item) => {
            const mark = item.state === 'complete' ? '[x]' : '[ ]';
            return `  ${mark} ${item.name}`;
          })
          .join('\n');
        return `### ${cl.name}\n${items}`;
      })
      .join('\n\n');
  }

  private formatComments(comments: TrelloComment[]): string {
    if (comments.length === 0) return 'Nenhum comentário recente.';

    return comments
      .map((c) => {
        const author = c.memberCreator?.fullName ?? 'Desconhecido';
        const date = new Date(c.date).toLocaleString('pt-BR');
        return `**${author}** (${date}):\n${c.data.text}`;
      })
      .join('\n\n---\n\n');
  }

  private formatSpreadsheets(spreadsheetTexts: string[]): string {
    if (spreadsheetTexts.length === 0) return 'Nenhuma planilha anexada.';
    return spreadsheetTexts.map((t) => this.truncateAttachment(t)).join('\n\n---\n\n');
  }

  private formatDocuments(documentTexts: string[]): string {
    if (documentTexts.length === 0) return 'Nenhum documento anexado.';
    return documentTexts.map((t) => this.truncateAttachment(t)).join('\n\n---\n\n');
  }

  private truncateAttachment(text: string): string {
    if (text.length <= this.MAX_ATTACHMENT_CHARS) return text;
    return (
      text.slice(0, this.MAX_ATTACHMENT_CHARS) +
      `\n\n[... truncado: ${text.length - this.MAX_ATTACHMENT_CHARS} caracteres omitidos ...]`
    );
  }

  private formatImagePaths(imagePaths: string[]): string {
    if (imagePaths.length === 0) return 'Nenhuma imagem anexada.';

    return (
      imagePaths.map((p) => `- ${p}`).join('\n') +
      '\n\n(Leia as imagens acima para entender o contexto visual do problema)'
    );
  }

  private spawnClaude(prompt: string, repoPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--output-format',
        'text',
        '--dangerously-skip-permissions',
        '--model',
        this.claudeModel,
        '--max-turns',
        String(this.claudeMaxTurns),
      ];

      const proc = spawn(this.claudeBin, args, {
        cwd: repoPath,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      proc.on('close', (code) => {
        if (stderr.trim()) {
          this.logger.warn(`Claude CLI stderr: ${stderr.trim()}`);
        }

        if (code !== 0) {
          reject(
            new Error(
              `Claude CLI encerrou com código ${code}.\nStderr: ${stderr.trim()}\nStdout: ${stdout.trim()}`,
            ),
          );
          return;
        }

        resolve(stdout);
      });

      proc.on('error', (err) => {
        reject(
          new Error(
            `Falha ao iniciar Claude CLI ("${this.claudeBin}"): ${err.message}. ` +
              'Verifique se o Claude CLI está instalado e no PATH.',
          ),
        );
      });

      proc.stdin.write(prompt, 'utf8');
      proc.stdin.end();
    });
  }

  private parseAndValidate(output: string): ClaudeTriageResult {
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1 || jsonStart > jsonEnd) {
      throw new Error(
        `Nenhum JSON encontrado na saída do Claude.\nSaída bruta: ${output.slice(0, 500)}`,
      );
    }

    const jsonStr = output.slice(jsonStart, jsonEnd + 1);
    let parsed: unknown;

    try {
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(
        `JSON inválido na saída do Claude: ${(err as Error).message}\n` +
          `JSON extraído: ${jsonStr.slice(0, 500)}`,
      );
    }

    return this.validateResult(parsed);
  }

  private validateResult(parsed: unknown): ClaudeTriageResult {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Resposta do Claude não é um objeto JSON.');
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.hipoteseInicial !== 'string' || !obj.hipoteseInicial.trim()) {
      throw new Error('Campo "hipoteseInicial" ausente ou inválido na resposta do Claude.');
    }

    if (!Array.isArray(obj.arquivosCandidatos)) {
      throw new Error('Campo "arquivosCandidatos" ausente ou não é array na resposta do Claude.');
    }

    if (!Array.isArray(obj.proximosPassosSugeridos)) {
      throw new Error('Campo "proximosPassosSugeridos" ausente ou não é array na resposta do Claude.');
    }

    return {
      hipoteseInicial: obj.hipoteseInicial,
      arquivosCandidatos: (obj.arquivosCandidatos as unknown[]).map(String),
      proximosPassosSugeridos: (obj.proximosPassosSugeridos as unknown[]).map(String),
    };
  }
}
