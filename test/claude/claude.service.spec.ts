import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  ClaudeService,
  ClaudeTriageResult,
} from '../../src/claude/claude.service';
import type {
  TrelloCard,
  TrelloChecklist,
  TrelloComment,
} from '../../src/trello/trello.types';

type ClaudeServiceTestable = {
  parseAndValidate(output: string): ClaudeTriageResult;
  validateResult(parsed: unknown): ClaudeTriageResult;
  formatChecklists(checklists: TrelloChecklist[]): string;
  formatComments(comments: TrelloComment[]): string;
  formatImagePaths(paths: string[]): string;
  formatSpreadsheets(texts: string[]): string;
  buildPrompt(
    card: TrelloCard,
    comments: TrelloComment[],
    imagePaths: string[],
    spreadsheetTexts: string[],
  ): string;
};

const mockConfig = {
  get: jest.fn((key: string, def?: string) => def ?? ''),
};

describe('ClaudeService', () => {
  let svc: ClaudeServiceTestable;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        ClaudeService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    svc = module.get(ClaudeService);
  });

  describe('parseAndValidate', () => {
    it('extrai e valida JSON válido da saída', () => {
      const output = `texto antes { "hipoteseInicial": "hipótese", "arquivosCandidatos": ["file.ts"], "proximosPassosSugeridos": ["passo 1"] } texto depois`;
      const result = svc.parseAndValidate(output);
      expect(result.hipoteseInicial).toBe('hipótese');
      expect(result.arquivosCandidatos).toEqual(['file.ts']);
      expect(result.proximosPassosSugeridos).toEqual(['passo 1']);
    });

    it('lança erro quando não há JSON na saída', () => {
      expect(() => svc.parseAndValidate('sem json aqui')).toThrow(
        'Nenhum JSON encontrado',
      );
    });

    it('lança erro quando JSON é inválido', () => {
      expect(() => svc.parseAndValidate('{ campo: sem aspas }')).toThrow(
        'JSON inválido',
      );
    });
  });

  describe('validateResult', () => {
    it('retorna resultado quando todos os campos são válidos', () => {
      const result = svc.validateResult({
        hipoteseInicial: 'hipótese',
        arquivosCandidatos: ['a.ts'],
        proximosPassosSugeridos: ['passo'],
      });
      expect(result).toEqual({
        hipoteseInicial: 'hipótese',
        arquivosCandidatos: ['a.ts'],
        proximosPassosSugeridos: ['passo'],
      });
    });

    it('lança erro quando hipoteseInicial está ausente', () => {
      expect(() =>
        svc.validateResult({
          arquivosCandidatos: [],
          proximosPassosSugeridos: [],
        }),
      ).toThrow('hipoteseInicial');
    });

    it('lança erro quando hipoteseInicial é string vazia', () => {
      expect(() =>
        svc.validateResult({
          hipoteseInicial: '   ',
          arquivosCandidatos: [],
          proximosPassosSugeridos: [],
        }),
      ).toThrow('hipoteseInicial');
    });

    it('lança erro quando arquivosCandidatos não é array', () => {
      expect(() =>
        svc.validateResult({
          hipoteseInicial: 'h',
          arquivosCandidatos: 'não é array',
          proximosPassosSugeridos: [],
        }),
      ).toThrow('arquivosCandidatos');
    });

    it('lança erro quando proximosPassosSugeridos não é array', () => {
      expect(() =>
        svc.validateResult({
          hipoteseInicial: 'h',
          arquivosCandidatos: [],
          proximosPassosSugeridos: null,
        }),
      ).toThrow('proximosPassosSugeridos');
    });

    it('converte itens dos arrays para string', () => {
      const result = svc.validateResult({
        hipoteseInicial: 'h',
        arquivosCandidatos: [42, true],
        proximosPassosSugeridos: [99],
      });
      expect(result.arquivosCandidatos).toEqual(['42', 'true']);
      expect(result.proximosPassosSugeridos).toEqual(['99']);
    });
  });

  describe('formatChecklists', () => {
    it('retorna mensagem padrão quando lista está vazia', () => {
      expect(svc.formatChecklists([])).toBe('Nenhum checklist.');
    });

    it('formata checklist com itens completos e incompletos', () => {
      const result = svc.formatChecklists([
        {
          id: '1',
          name: 'QA',
          checkItems: [
            { id: 'a', name: 'Testar login', state: 'complete' },
            { id: 'b', name: 'Testar logout', state: 'incomplete' },
          ],
        },
      ]);
      expect(result).toContain('### QA');
      expect(result).toContain('[x] Testar login');
      expect(result).toContain('[ ] Testar logout');
    });

    it('formata múltiplos checklists separados', () => {
      const result = svc.formatChecklists([
        { id: '1', name: 'Lista A', checkItems: [] },
        { id: '2', name: 'Lista B', checkItems: [] },
      ]);
      expect(result).toContain('### Lista A');
      expect(result).toContain('### Lista B');
    });
  });

  describe('formatComments', () => {
    it('retorna mensagem padrão quando não há comentários', () => {
      expect(svc.formatComments([])).toBe('Nenhum comentário recente.');
    });

    it('formata comentário com autor e texto', () => {
      const comment: TrelloComment = {
        id: '1',
        date: '2026-01-01T00:00:00.000Z',
        data: { text: 'Texto do comentário' },
        memberCreator: { id: 'm1', fullName: 'João Silva', username: 'joao' },
      };
      const result = svc.formatComments([comment]);
      expect(result).toContain('João Silva');
      expect(result).toContain('Texto do comentário');
    });

    it('separa múltiplos comentários com divisor', () => {
      const make = (id: string, text: string): TrelloComment => ({
        id,
        date: '2026-01-01T00:00:00.000Z',
        data: { text },
        memberCreator: { id: 'm1', fullName: 'Autor', username: 'autor' },
      });
      const result = svc.formatComments([
        make('1', 'primeiro'),
        make('2', 'segundo'),
      ]);
      expect(result).toContain('primeiro');
      expect(result).toContain('segundo');
      expect(result).toContain('---');
    });
  });

  describe('formatImagePaths', () => {
    it('retorna mensagem padrão quando não há imagens', () => {
      expect(svc.formatImagePaths([])).toBe('Nenhuma imagem anexada.');
    });

    it('lista os caminhos das imagens', () => {
      const result = svc.formatImagePaths(['/tmp/img1.png', '/tmp/img2.jpg']);
      expect(result).toContain('- /tmp/img1.png');
      expect(result).toContain('- /tmp/img2.jpg');
    });
  });

  describe('formatSpreadsheets', () => {
    it('retorna mensagem padrão quando não há planilhas', () => {
      expect(svc.formatSpreadsheets([])).toBe('Nenhuma planilha anexada.');
    });

    it('une textos de planilhas com separador', () => {
      const result = svc.formatSpreadsheets(['planilha A', 'planilha B']);
      expect(result).toContain('planilha A');
      expect(result).toContain('planilha B');
    });
  });

  describe('buildPrompt', () => {
    const makeCard = (overrides: Partial<TrelloCard> = {}): TrelloCard => ({
      id: 'c1',
      name: 'Bug no login',
      desc: 'Erro ao logar',
      idList: 'l1',
      labels: [],
      checklists: [],
      ...overrides,
    });

    it('inclui título e descrição do card', () => {
      const result = svc.buildPrompt(makeCard(), [], [], []);
      expect(result).toContain('Bug no login');
      expect(result).toContain('Erro ao logar');
    });

    it('usa fallback quando descrição está vazia', () => {
      const result = svc.buildPrompt(makeCard({ desc: '' }), [], [], []);
      expect(result).toContain('Sem descrição informada.');
    });

    it('inclui formato JSON obrigatório na instrução', () => {
      const result = svc.buildPrompt(makeCard(), [], [], []);
      expect(result).toContain('hipoteseInicial');
      expect(result).toContain('arquivosCandidatos');
      expect(result).toContain('proximosPassosSugeridos');
    });
  });
});
