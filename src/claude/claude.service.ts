import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import type { TrelloCard, TrelloComment } from '../trello/trello.types.js';

export interface ClaudeTriageResult {
  hipoteseInicial: string;
  arquivosCandidatos: string[];
  proximosPassosSugeridos: string[];
}

type FallbackProviderName = 'gemini' | 'deepseek';

interface FallbackProviderConfig {
  name: FallbackProviderName;
  label: string;
  apiKey: string;
  model: string;
  baseUrl: string;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: { message?: string };
}

interface DeepSeekChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: { message?: string };
}

interface RepoCandidate {
  relativePath: string;
  pathScore: number;
}

interface RepoSnippet {
  relativePath: string;
  score: number;
  matchedTerms: string[];
  snippet: string;
}

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);

  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly MAX_ATTACHMENT_CHARS = 80_000;
  private readonly REPO_CONTEXT_SCAN_LIMIT: number;
  private readonly REPO_CONTEXT_SNIPPET_LIMIT: number;
  private readonly REPO_CONTEXT_FILE_BYTES_LIMIT: number;
  private readonly REPO_CONTEXT_TOTAL_CHARS_LIMIT: number;
  private readonly REPO_CONTEXT_TERMS_LIMIT: number;

  private readonly claudeBin: string;
  private readonly claudeModel: string;
  private readonly claudeMaxTurns: number;
  private readonly geminiApiKey: string;
  private readonly geminiModel: string;
  private readonly geminiApiBaseUrl: string;
  private readonly deepSeekApiKey: string;
  private readonly deepSeekModel: string;
  private readonly deepSeekApiBaseUrl: string;
  private readonly fallbackProviderOrder: FallbackProviderName[];

  private readonly triageJsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      hipoteseInicial: { type: 'string' },
      arquivosCandidatos: {
        type: 'array',
        items: { type: 'string' },
      },
      proximosPassosSugeridos: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: [
      'hipoteseInicial',
      'arquivosCandidatos',
      'proximosPassosSugeridos',
    ],
  } as const;

  private readonly repoContextIgnoredDirs = new Set([
    '.git',
    '.idea',
    '.next',
    '.nuxt',
    '.turbo',
    '.vscode',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'tmp',
    'temp',
    'vendor',
  ]);

  private readonly repoContextPriorityFiles = new Set([
    'package.json',
    'README.md',
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    'nest-cli.json',
    'tsconfig.json',
    'tsconfig.build.json',
  ]);

  private readonly repoContextAllowedExtensions = new Set([
    '.c',
    '.cs',
    '.css',
    '.env',
    '.go',
    '.graphql',
    '.h',
    '.html',
    '.java',
    '.js',
    '.json',
    '.jsx',
    '.kt',
    '.kts',
    '.md',
    '.mjs',
    '.php',
    '.properties',
    '.py',
    '.rb',
    '.rs',
    '.scss',
    '.sh',
    '.sql',
    '.svg',
    '.toml',
    '.ts',
    '.tsx',
    '.txt',
    '.xml',
    '.yaml',
    '.yml',
  ]);

  private readonly repoContextStopWords = new Set([
    'about',
    'acima',
    'agora',
    'algum',
    'alguma',
    'analise',
    'analisa',
    'analiseo',
    'antes',
    'apenas',
    'arquivo',
    'arquivos',
    'assim',
    'automatica',
    'automatico',
    'base',
    'basta',
    'card',
    'checklists',
    'chamado',
    'chamados',
    'codigo',
    'com',
    'comentario',
    'comentarios',
    'como',
    'conforme',
    'contexto',
    'dados',
    'deixe',
    'depois',
    'descricao',
    'detalhes',
    'diretorio',
    'documento',
    'documentos',
    'engenheiro',
    'entre',
    'essa',
    'esse',
    'esta',
    'estao',
    'faca',
    'favor',
    'fora',
    'formato',
    'hipotese',
    'identificar',
    'identifique',
    'imagem',
    'imagens',
    'inicial',
    'investigacao',
    'json',
    'lista',
    'local',
    'markdown',
    'mais',
    'mesmo',
    'nenhum',
    'nenhuma',
    'obrigatorias',
    'objeto',
    'para',
    'passo',
    'passos',
    'pelos',
    'pelo',
    'planilha',
    'planilhas',
    'pode',
    'portugues',
    'proponha',
    'proximos',
    'recentes',
    'relacione',
    'relevantes',
    'repo',
    'repositorio',
    'responda',
    'resposta',
    'senior',
    'sem',
    'seu',
    'somente',
    'sua',
    'tecnica',
    'texto',
    'titulo',
    'trabalho',
    'triagem',
    'uma',
    'use',
    'valido',
    'voce',
  ]);

  constructor(private readonly config: ConfigService) {
    this.claudeBin = this.config.get<string>('CLAUDE_BIN', 'claude');
    this.claudeModel = this.config.get<string>('CLAUDE_MODEL', 'sonnet');
    this.claudeMaxTurns = this.parseIntegerConfig('CLAUDE_MAX_TURNS', 30);
    this.geminiApiKey = this.config.get<string>('GEMINI_API_KEY', '').trim();
    this.geminiModel = this.config.get<string>(
      'GEMINI_MODEL',
      'gemini-2.5-pro',
    );
    this.geminiApiBaseUrl = this.config
      .get<string>(
        'GEMINI_API_BASE_URL',
        'https://generativelanguage.googleapis.com/v1beta',
      )
      .replace(/\/$/, '');
    this.deepSeekApiKey = this.config
      .get<string>('DEEPSEEK_API_KEY', '')
      .trim();
    this.deepSeekModel = this.config.get<string>(
      'DEEPSEEK_MODEL',
      'deepseek-chat',
    );
    this.deepSeekApiBaseUrl = this.config
      .get<string>('DEEPSEEK_API_BASE_URL', 'https://api.deepseek.com')
      .replace(/\/$/, '');
    this.fallbackProviderOrder = this.parseFallbackProviderOrder();
    this.REPO_CONTEXT_SCAN_LIMIT = this.parseIntegerConfig(
      'TRIAGE_REPO_CONTEXT_SCAN_LIMIT',
      250,
    );
    this.REPO_CONTEXT_SNIPPET_LIMIT = this.parseIntegerConfig(
      'TRIAGE_REPO_CONTEXT_SNIPPET_LIMIT',
      6,
    );
    this.REPO_CONTEXT_FILE_BYTES_LIMIT = this.parseIntegerConfig(
      'TRIAGE_REPO_CONTEXT_FILE_BYTES_LIMIT',
      64_000,
    );
    this.REPO_CONTEXT_TOTAL_CHARS_LIMIT = this.parseIntegerConfig(
      'TRIAGE_REPO_CONTEXT_TOTAL_CHARS_LIMIT',
      9_000,
    );
    this.REPO_CONTEXT_TERMS_LIMIT = this.parseIntegerConfig(
      'TRIAGE_REPO_CONTEXT_TERMS_LIMIT',
      12,
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
    const prompt = this.buildPrompt(
      card,
      comments,
      imagePaths,
      spreadsheetTexts,
      documentTexts,
    );
    this.logger.log(`Executando Claude CLI em: ${repoPath}`);
    this.logger.debug(`Prompt montado (${prompt.length} chars)`);

    return this.runWithRetry(prompt, repoPath, imagePaths);
  }

  private async runWithRetry(
    prompt: string,
    repoPath: string,
    imagePaths: string[],
  ): Promise<ClaudeTriageResult> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const rawOutput = await this.spawnClaude(prompt, repoPath);
        return this.parseAndValidate(rawOutput);
      } catch (err) {
        lastError = err as Error;

        if (this.shouldFallbackToApi(lastError)) {
          return this.runWithFallbackProviders(prompt, repoPath, imagePaths);
        }

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

  private shouldFallbackToApi(error: Error): boolean {
    const message = error.message.toLowerCase();

    return (
      message.includes("you've hit your limit") ||
      message.includes('you have hit your limit') ||
      message.includes('hit your limit') ||
      message.includes('rate limit') ||
      message.includes('usage limit')
    );
  }

  private async runWithFallbackProviders(
    prompt: string,
    repoPath: string,
    imagePaths: string[],
  ): Promise<ClaudeTriageResult> {
    const providers = this.getConfiguredFallbackProviders();
    if (providers.length === 0) {
      throw new Error(
        'Claude CLI atingiu o limite de uso e nenhum fallback configurado. ' +
          'Defina GEMINI_API_KEY para o fallback principal ou DEEPSEEK_API_KEY para habilitar o fallback econômico.',
      );
    }

    const fallbackPrompt = await this.buildFallbackPrompt(prompt, repoPath);
    let lastError: Error | undefined;

    for (const provider of providers) {
      try {
        this.logger.warn(
          `Claude CLI atingiu o limite de uso. Acionando fallback para ${provider.label} (${provider.model}).`,
        );

        switch (provider.name) {
          case 'gemini':
            return await this.runWithGemini(fallbackPrompt, imagePaths);
          case 'deepseek':
            return await this.runWithDeepSeek(fallbackPrompt);
        }
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(
          `Fallback ${provider.label} falhou: ${lastError.message}`,
        );
      }
    }

    throw new Error(
      'Claude CLI atingiu o limite de uso e todos os fallbacks configurados falharam. ' +
        `Último erro: ${lastError?.message ?? 'sem detalhes'}`,
    );
  }

  private getConfiguredFallbackProviders(): FallbackProviderConfig[] {
    const providers: Record<FallbackProviderName, FallbackProviderConfig> = {
      gemini: {
        name: 'gemini',
        label: 'Gemini',
        apiKey: this.geminiApiKey,
        model: this.geminiModel,
        baseUrl: this.geminiApiBaseUrl,
      },
      deepseek: {
        name: 'deepseek',
        label: 'DeepSeek',
        apiKey: this.deepSeekApiKey,
        model: this.deepSeekModel,
        baseUrl: this.deepSeekApiBaseUrl,
      },
    };

    return this.fallbackProviderOrder
      .map((providerName) => providers[providerName])
      .filter((provider) => provider.apiKey);
  }

  private parseFallbackProviderOrder(): FallbackProviderName[] {
    const raw = this.config.get<string>(
      'TRIAGE_FALLBACK_PROVIDERS',
      'gemini,deepseek',
    );
    const allowed = new Set<FallbackProviderName>(['gemini', 'deepseek']);
    const uniqueProviders = new Set<FallbackProviderName>();

    for (const entry of raw.split(',')) {
      const provider = entry.trim().toLowerCase() as FallbackProviderName;
      if (!provider) continue;
      if (!allowed.has(provider)) {
        this.logger.warn(
          `Provider de fallback ignorado por ser desconhecido: "${entry.trim()}"`,
        );
        continue;
      }
      uniqueProviders.add(provider);
    }

    return uniqueProviders.size > 0
      ? Array.from(uniqueProviders)
      : ['gemini', 'deepseek'];
  }

  private async buildFallbackPrompt(
    prompt: string,
    repoPath: string,
  ): Promise<string> {
    try {
      const repoContext = await this.buildRepoContext(repoPath, prompt);
      if (!repoContext) return prompt;

      const marker = '\n## Instruções obrigatórias';
      const section =
        '\n## Contexto adicional do repositório local\n\n' +
        'Os trechos abaixo foram extraídos automaticamente do repositório local para dar suporte ao fallback por API.\n' +
        'Use esse contexto como evidência do código ao formular a hipótese e ao escolher os arquivos candidatos.\n\n' +
        `${repoContext}\n`;

      if (prompt.includes(marker)) {
        return prompt.replace(marker, `${section}${marker}`);
      }

      return `${prompt}${section}`;
    } catch (err) {
      this.logger.warn(
        `Não foi possível montar contexto adicional do repositório para o fallback: ${(err as Error).message}`,
      );
      return prompt;
    }
  }

  private async buildRepoContext(
    repoPath: string,
    prompt: string,
  ): Promise<string> {
    const searchTerms = this.extractSearchTerms(prompt);
    const files = await this.collectRepoFiles(repoPath);
    if (files.length === 0) return '';

    const candidates = files
      .map((relativePath) => ({
        relativePath,
        pathScore: this.scorePath(relativePath, searchTerms),
      }))
      .sort((a, b) => b.pathScore - a.pathScore || a.relativePath.localeCompare(b.relativePath))
      .slice(0, this.REPO_CONTEXT_SCAN_LIMIT);

    const snippets: RepoSnippet[] = [];
    for (const candidate of candidates) {
      const snippet = await this.inspectRepoCandidate(
        repoPath,
        candidate,
        searchTerms,
      );
      if (snippet) {
        snippets.push(snippet);
      }
    }

    const selectedSnippets = snippets
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .slice(0, this.REPO_CONTEXT_SNIPPET_LIMIT);

    if (selectedSnippets.length === 0) {
      return files
        .slice(0, Math.min(files.length, 6))
        .map((file) => `- ${file}`)
        .join('\n');
    }

    let totalChars = 0;
    const sections: string[] = [];

    for (const snippet of selectedSnippets) {
      const matchedTerms =
        snippet.matchedTerms.length > 0
          ? `Termos relacionados: ${snippet.matchedTerms.join(', ')}\n`
          : '';
      const section =
        `### ${snippet.relativePath}\n` +
        matchedTerms +
        'Trecho relevante:\n' +
        `${snippet.snippet}\n`;

      if (
        sections.length > 0 &&
        totalChars + section.length > this.REPO_CONTEXT_TOTAL_CHARS_LIMIT
      ) {
        break;
      }

      totalChars += section.length;
      sections.push(section);
    }

    return sections.join('\n');
  }

  private async collectRepoFiles(
    repoPath: string,
    currentDir = repoPath,
    acc: string[] = [],
  ): Promise<string[]> {
    if (acc.length >= this.REPO_CONTEXT_SCAN_LIMIT) {
      return acc;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (acc.length >= this.REPO_CONTEXT_SCAN_LIMIT) {
        break;
      }

      const fullPath = join(currentDir, entry.name);
      const relativePath = relative(repoPath, fullPath);

      if (entry.isDirectory()) {
        if (this.repoContextIgnoredDirs.has(entry.name)) {
          continue;
        }
        await this.collectRepoFiles(repoPath, fullPath, acc);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!this.shouldInspectRepoFile(relativePath)) {
        continue;
      }

      acc.push(relativePath);
    }

    return acc;
  }

  private shouldInspectRepoFile(relativePath: string): boolean {
    const filename = basename(relativePath);
    if (this.repoContextPriorityFiles.has(filename)) {
      return true;
    }

    if (relativePath.includes('.min.')) {
      return false;
    }

    return this.repoContextAllowedExtensions.has(
      extname(relativePath).toLowerCase(),
    );
  }

  private async inspectRepoCandidate(
    repoPath: string,
    candidate: RepoCandidate,
    searchTerms: string[],
  ): Promise<RepoSnippet | null> {
    const fullPath = join(repoPath, candidate.relativePath);
    const fileStat = await stat(fullPath);
    if (fileStat.size > this.REPO_CONTEXT_FILE_BYTES_LIMIT) {
      return null;
    }

    let content: string;
    try {
      content = await readFile(fullPath, 'utf8');
    } catch {
      return null;
    }

    if (!content.trim() || content.includes('\u0000')) {
      return null;
    }

    const matchedTerms = this.findMatchingTerms(
      `${candidate.relativePath}\n${content}`,
      searchTerms,
    );
    const contentScore = this.scoreText(content, searchTerms);
    const score =
      candidate.pathScore * 3 +
      contentScore +
      (this.repoContextPriorityFiles.has(basename(candidate.relativePath))
        ? 2
        : 0);

    if (score <= 0 && matchedTerms.length === 0) {
      return null;
    }

    const snippet = this.extractRelevantSnippet(content, searchTerms);
    if (!snippet) {
      return null;
    }

    return {
      relativePath: candidate.relativePath,
      score,
      matchedTerms,
      snippet,
    };
  }

  private extractSearchTerms(prompt: string): string[] {
    const normalized = this.normalizeText(prompt);
    const tokens = normalized.match(/[a-z0-9._/-]{3,}/g) ?? [];
    const terms: string[] = [];
    const seen = new Set<string>();

    for (const token of tokens) {
      for (const part of token.split(/[^a-z0-9]+/g)) {
        const candidate = part.trim();
        if (
          candidate.length < 4 ||
          this.repoContextStopWords.has(candidate) ||
          /^\d+$/.test(candidate) ||
          seen.has(candidate)
        ) {
          continue;
        }

        seen.add(candidate);
        terms.push(candidate);

        if (terms.length >= this.REPO_CONTEXT_TERMS_LIMIT) {
          return terms;
        }
      }
    }

    return terms;
  }

  private scorePath(relativePath: string, searchTerms: string[]): number {
    const pathText = this.normalizeText(relativePath);
    const fileName = this.normalizeText(basename(relativePath));
    let score = this.repoContextPriorityFiles.has(basename(relativePath))
      ? 1
      : 0;

    for (const term of searchTerms) {
      if (pathText.includes(term)) score += 2;
      if (fileName.includes(term)) score += 3;
    }

    return score;
  }

  private scoreText(text: string, searchTerms: string[]): number {
    if (searchTerms.length === 0) {
      return 0;
    }

    const normalized = this.normalizeText(text);
    let score = 0;

    for (const term of searchTerms) {
      const occurrences = normalized.split(term).length - 1;
      score += Math.min(occurrences, 3);
    }

    return score;
  }

  private findMatchingTerms(text: string, searchTerms: string[]): string[] {
    const normalized = this.normalizeText(text);
    return searchTerms.filter((term) => normalized.includes(term)).slice(0, 5);
  }

  private extractRelevantSnippet(
    content: string,
    searchTerms: string[],
  ): string {
    const lines = content.replace(/\r/g, '').split('\n');
    let bestIndex = -1;
    let bestScore = -1;

    for (let index = 0; index < lines.length; index++) {
      const lineScore = this.scoreText(lines[index], searchTerms);
      if (lineScore > bestScore) {
        bestScore = lineScore;
        bestIndex = index;
      }
    }

    if (bestIndex === -1) {
      return '';
    }

    const start = Math.max(0, bestIndex - 4);
    const end = Math.min(lines.length, bestIndex + 5);

    return lines
      .slice(start, end)
      .map((line, offset) => {
        const lineNumber = start + offset + 1;
        return `${lineNumber}: ${line.slice(0, 220)}`;
      })
      .join('\n');
  }

  private async runWithGemini(
    prompt: string,
    imagePaths: string[],
  ): Promise<ClaudeTriageResult> {
    const imageParts = await this.buildGeminiImageParts(imagePaths);
    const url = `${this.geminiApiBaseUrl}/models/${this.geminiModel}:generateContent?key=${encodeURIComponent(this.geminiApiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }, ...imageParts],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: this.triageJsonSchema,
        },
      }),
    });

    const responseBody =
      (await response.json().catch(() => null)) as GeminiGenerateContentResponse | null;

    if (!response.ok) {
      throw new Error(
        `Gemini API erro no fallback: HTTP ${response.status} — ` +
          `${responseBody?.error?.message ?? 'sem detalhes'}`,
      );
    }

    const outputText = this.extractGeminiOutputText(responseBody);
    return this.parseAndValidate(outputText);
  }

  private async runWithDeepSeek(
    prompt: string,
  ): Promise<ClaudeTriageResult> {
    const url = `${this.deepSeekApiBaseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.deepSeekApiKey}`,
      },
      body: JSON.stringify({
        model: this.deepSeekModel,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Responda apenas com JSON válido, sem markdown e sem texto fora do objeto.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    const responseBody =
      (await response.json().catch(() => null)) as DeepSeekChatCompletionResponse | null;

    if (!response.ok) {
      throw new Error(
        `DeepSeek API erro no fallback: HTTP ${response.status} — ` +
          `${responseBody?.error?.message ?? 'sem detalhes'}`,
      );
    }

    const outputText = this.extractDeepSeekOutputText(responseBody);
    return this.parseAndValidate(outputText);
  }

  private async buildGeminiImageParts(
    imagePaths: string[],
  ): Promise<Array<{ inline_data: { mime_type: string; data: string } }>> {
    const results = await Promise.all(
      imagePaths.map(async (imagePath) => {
        try {
          const buffer = await readFile(imagePath);
          return {
            inline_data: {
              mime_type: this.getImageMimeType(imagePath),
              data: buffer.toString('base64'),
            },
          };
        } catch (err) {
          this.logger.warn(
            `Não foi possível anexar imagem ao fallback do Gemini (${imagePath}): ${(err as Error).message}`,
          );
          return null;
        }
      }),
    );

    return results.filter((result) => result !== null);
  }

  private getImageMimeType(imagePath: string): string {
    const ext = extname(imagePath).toLowerCase();

    switch (ext) {
      case '.bmp':
        return 'image/bmp';
      case '.gif':
        return 'image/gif';
      case '.heic':
        return 'image/heic';
      case '.heif':
        return 'image/heif';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.svg':
        return 'image/svg+xml';
      case '.webp':
        return 'image/webp';
      default:
        return 'image/png';
    }
  }

  private extractGeminiOutputText(
    responseBody: GeminiGenerateContentResponse | null,
  ): string {
    const text = responseBody?.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .find((part) => typeof part.text === 'string' && part.text.trim())
      ?.text;

    if (text?.trim()) {
      return text;
    }

    throw new Error('Gemini API retornou uma resposta sem texto utilizável.');
  }

  private extractDeepSeekOutputText(
    responseBody: DeepSeekChatCompletionResponse | null,
  ): string {
    const text = responseBody?.choices?.[0]?.message?.content;

    if (text?.trim()) {
      return text;
    }

    throw new Error(
      'DeepSeek API retornou uma resposta sem texto utilizável.',
    );
  }

  private buildPrompt(
    card: TrelloCard,
    comments: TrelloComment[],
    imagePaths: string[],
    spreadsheetTexts: string[],
    documentTexts: string[] = [],
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
    return spreadsheetTexts
      .map((t) => this.truncateAttachment(t))
      .join('\n\n---\n\n');
  }

  private formatDocuments(documentTexts: string[]): string {
    if (documentTexts.length === 0) return 'Nenhum documento anexado.';
    return documentTexts
      .map((t) => this.truncateAttachment(t))
      .join('\n\n---\n\n');
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
        `Nenhum JSON encontrado na saída do modelo.\nSaída bruta: ${output.slice(0, 500)}`,
      );
    }

    const jsonStr = output.slice(jsonStart, jsonEnd + 1);
    let parsed: unknown;

    try {
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(
        `JSON inválido na saída do modelo: ${(err as Error).message}\n` +
          `JSON extraído: ${jsonStr.slice(0, 500)}`,
      );
    }

    return this.validateResult(parsed);
  }

  private validateResult(parsed: unknown): ClaudeTriageResult {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Resposta do modelo não é um objeto JSON.');
    }

    const obj = parsed as Record<string, unknown>;

    if (
      typeof obj.hipoteseInicial !== 'string' ||
      !obj.hipoteseInicial.trim()
    ) {
      throw new Error(
        'Campo "hipoteseInicial" ausente ou inválido na resposta do modelo.',
      );
    }

    if (!Array.isArray(obj.arquivosCandidatos)) {
      throw new Error(
        'Campo "arquivosCandidatos" ausente ou não é array na resposta do modelo.',
      );
    }

    if (!Array.isArray(obj.proximosPassosSugeridos)) {
      throw new Error(
        'Campo "proximosPassosSugeridos" ausente ou não é array na resposta do modelo.',
      );
    }

    return {
      hipoteseInicial: obj.hipoteseInicial,
      arquivosCandidatos: (obj.arquivosCandidatos as unknown[]).map(String),
      proximosPassosSugeridos: (obj.proximosPassosSugeridos as unknown[]).map(
        String,
      ),
    };
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  }

  private parseIntegerConfig(key: string, fallback: number): number {
    const value = this.config.get<string>(key);
    const parsed = parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
