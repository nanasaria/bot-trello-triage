import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TriageService } from '../../src/triage/triage.service';
import { TrelloService } from '../../src/trello/trello.service';
import { ClaudeService } from '../../src/claude/claude.service';
import type { TrelloAction } from '../../src/trello/trello.types';

type TriageResult = {
  hipoteseInicial: string;
  arquivosCandidatos: string[];
  proximosPassosSugeridos: string[];
};

type TriageServicePrivate = {
  extractTargetListId(action: TrelloAction): string | null;
  resolveRepoPath(labelNames: string[]): string | null;
  formatTriageComment(result: TriageResult): string;
  trackActionId(actionId: string): void;
  handleAction(action: TrelloAction): Promise<void>;
  processedActionIds: Map<string, true>;
  PROCESSED_IDS_MAX: number;
  repoLabelMap: Record<string, string>;
  defaultRepoPath: string;
};

jest.mock('node:fs/promises', () => ({
  mkdtemp: jest.fn().mockResolvedValue('/tmp/triage-card-abc'),
  rm: jest.fn().mockResolvedValue(undefined),
}));

const mockTrelloService = {
  getTargetListId: jest.fn().mockResolvedValue('list-alvo'),
  hasTriageComment: jest.fn().mockResolvedValue(false),
  fetchCard: jest.fn().mockResolvedValue({
    id: 'card-1',
    name: 'Bug',
    desc: 'descrição',
    idList: 'list-alvo',
    labels: [],
    checklists: [],
  }),
  fetchRecentComments: jest.fn().mockResolvedValue([]),
  fetchAttachments: jest
    .fn()
    .mockResolvedValue({ images: [], spreadsheets: [] }),
  downloadAttachmentToDir: jest.fn(),
  downloadSpreadsheetAsText: jest.fn(),
  postComment: jest.fn().mockResolvedValue(undefined),
};

const mockClaudeService = {
  runTriage: jest.fn().mockResolvedValue({
    hipoteseInicial: 'Hipótese de teste',
    arquivosCandidatos: ['src/app.ts'],
    proximosPassosSugeridos: ['Passo 1'],
  }),
};

const mockConfig = {
  get: jest.fn((key: string, def?: string) => {
    if (key === 'REPO_LABEL_MAP') return '{"repo:api":"/srv/api"}';
    if (key === 'DEFAULT_REPO_PATH') return '/srv/default';
    return def ?? '';
  }),
};

describe('TriageService', () => {
  let service: TriageService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        TriageService,
        { provide: TrelloService, useValue: mockTrelloService },
        { provide: ClaudeService, useValue: mockClaudeService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get(TriageService);
  });

  describe('extractTargetListId', () => {
    it('retorna id da lista em ação createCard', () => {
      const action: TrelloAction = {
        id: 'a1',
        type: 'createCard',
        date: '',
        data: {
          list: { id: 'list-1', name: 'Lista' },
          card: { id: 'c1', name: 'Card' },
        },
      };
      expect(
        (service as unknown as TriageServicePrivate).extractTargetListId(
          action,
        ),
      ).toBe('list-1');
    });

    it('retorna id da listAfter em ação updateCard', () => {
      const action: TrelloAction = {
        id: 'a1',
        type: 'updateCard',
        date: '',
        data: {
          listAfter: { id: 'list-2', name: 'Nova Lista' },
          card: { id: 'c1', name: 'Card' },
        },
      };
      expect(
        (service as unknown as TriageServicePrivate).extractTargetListId(
          action,
        ),
      ).toBe('list-2');
    });

    it('retorna null para updateCard sem listAfter', () => {
      const action: TrelloAction = {
        id: 'a1',
        type: 'updateCard',
        date: '',
        data: { card: { id: 'c1', name: 'Card' } },
      };
      expect(
        (service as unknown as TriageServicePrivate).extractTargetListId(
          action,
        ),
      ).toBeNull();
    });

    it('retorna null para tipos não tratados', () => {
      const action: TrelloAction = {
        id: 'a1',
        type: 'commentCard',
        date: '',
        data: {},
      };
      expect(
        (service as unknown as TriageServicePrivate).extractTargetListId(
          action,
        ),
      ).toBeNull();
    });
  });

  describe('resolveRepoPath', () => {
    it('retorna caminho pelo mapeamento de label', () => {
      expect(
        (service as unknown as TriageServicePrivate).resolveRepoPath([
          'bug',
          'repo:api',
        ]),
      ).toBe('/srv/api');
    });

    it('retorna defaultRepoPath quando nenhuma label repo: é encontrada', () => {
      expect(
        (service as unknown as TriageServicePrivate).resolveRepoPath([
          'bug',
          'frontend',
        ]),
      ).toBe('/srv/default');
    });

    it('retorna null quando não há label e defaultRepoPath está vazio', () => {
      (service as unknown as TriageServicePrivate).defaultRepoPath = '';
      expect(
        (service as unknown as TriageServicePrivate).resolveRepoPath([]),
      ).toBeNull();
    });

    it('ignora label repo: que não está no mapa', () => {
      expect(
        (service as unknown as TriageServicePrivate).resolveRepoPath([
          'repo:desconhecido',
        ]),
      ).toBe('/srv/default');
    });
  });

  describe('formatTriageComment', () => {
    it('inclui o cabeçalho obrigatório', () => {
      const result = (
        service as unknown as TriageServicePrivate
      ).formatTriageComment({
        hipoteseInicial: 'Hipótese',
        arquivosCandidatos: ['src/app.ts'],
        proximosPassosSugeridos: ['Passo 1'],
      });
      expect(result).toContain('[Análise técnica automática]');
    });

    it('formata arquivos candidatos como lista', () => {
      const result = (
        service as unknown as TriageServicePrivate
      ).formatTriageComment({
        hipoteseInicial: 'Hipótese',
        arquivosCandidatos: ['src/a.ts', 'src/b.ts'],
        proximosPassosSugeridos: [],
      });
      expect(result).toContain('- src/a.ts');
      expect(result).toContain('- src/b.ts');
    });

    it('formata próximos passos numerados', () => {
      const result = (
        service as unknown as TriageServicePrivate
      ).formatTriageComment({
        hipoteseInicial: 'Hipótese',
        arquivosCandidatos: [],
        proximosPassosSugeridos: ['Verificar logs', 'Testar endpoint'],
      });
      expect(result).toContain('1. Verificar logs');
      expect(result).toContain('2. Testar endpoint');
    });

    it('usa mensagem padrão quando não há arquivos candidatos', () => {
      const result = (
        service as unknown as TriageServicePrivate
      ).formatTriageComment({
        hipoteseInicial: 'Hipótese',
        arquivosCandidatos: [],
        proximosPassosSugeridos: [],
      });
      expect(result).toContain('Nenhum arquivo específico identificado');
    });
  });

  describe('trackActionId', () => {
    it('adiciona actionId ao mapa', () => {
      (service as unknown as TriageServicePrivate).trackActionId('action-1');
      expect(
        (service as unknown as TriageServicePrivate).processedActionIds.has(
          'action-1',
        ),
      ).toBe(true);
    });

    it('remove o mais antigo quando o limite é atingido', () => {
      const max: number = (service as unknown as TriageServicePrivate)
        .PROCESSED_IDS_MAX;
      for (let i = 0; i < max; i++) {
        (service as unknown as TriageServicePrivate).trackActionId(
          `action-${i}`,
        );
      }
      (service as unknown as TriageServicePrivate).trackActionId('action-nova');
      expect(
        (service as unknown as TriageServicePrivate).processedActionIds.has(
          'action-0',
        ),
      ).toBe(false);
      expect(
        (service as unknown as TriageServicePrivate).processedActionIds.has(
          'action-nova',
        ),
      ).toBe(true);
      expect(
        (service as unknown as TriageServicePrivate).processedActionIds.size,
      ).toBe(max);
    });
  });

  describe('parseRepoLabelMap', () => {
    it('carrega o mapa do REPO_LABEL_MAP corretamente', () => {
      expect((service as unknown as TriageServicePrivate).repoLabelMap).toEqual(
        { 'repo:api': '/srv/api' },
      );
    });

    it('retorna mapa vazio quando REPO_LABEL_MAP é JSON inválido', () => {
      const invalidConfig = {
        get: jest.fn((key: string, def?: string) => {
          if (key === 'REPO_LABEL_MAP') return 'não é json';
          return def ?? '';
        }),
      };
      const svc = new TriageService(
        mockTrelloService as unknown as TrelloService,
        mockClaudeService as unknown as ClaudeService,
        invalidConfig as unknown as ConfigService,
      );
      expect((svc as unknown as TriageServicePrivate).repoLabelMap).toEqual({});
    });

    it('retorna mapa vazio quando REPO_LABEL_MAP é um array', () => {
      const arrayConfig = {
        get: jest.fn((key: string, def?: string) => {
          if (key === 'REPO_LABEL_MAP') return '["não é objeto"]';
          return def ?? '';
        }),
      };
      const svc = new TriageService(
        mockTrelloService as unknown as TrelloService,
        mockClaudeService as unknown as ClaudeService,
        arrayConfig as unknown as ConfigService,
      );
      expect((svc as unknown as TriageServicePrivate).repoLabelMap).toEqual({});
    });
  });

  describe('handleAction', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('ignora action já processada', async () => {
      (service as unknown as TriageServicePrivate).processedActionIds.set(
        'a-dup',
        true,
      );
      const action: TrelloAction = {
        id: 'a-dup',
        type: 'createCard',
        date: '',
        data: {
          list: { id: 'list-alvo', name: 'Lista' },
          card: { id: 'c1', name: 'Card' },
        },
      };
      await (service as unknown as TriageServicePrivate).handleAction(action);
      expect(mockTrelloService.getTargetListId).not.toHaveBeenCalled();
    });

    it('ignora action de lista diferente da alvo', async () => {
      const action: TrelloAction = {
        id: 'a1',
        type: 'createCard',
        date: '',
        data: {
          list: { id: 'outra-lista', name: 'Outra' },
          card: { id: 'c1', name: 'Card' },
        },
      };
      const processSpy = jest
        .spyOn(service as any, 'processTriageForCard')
        .mockResolvedValue(undefined);
      await (service as unknown as TriageServicePrivate).handleAction(action);
      expect(processSpy).not.toHaveBeenCalled();
    });

    it('chama processTriageForCard para ação na lista alvo', async () => {
      const action: TrelloAction = {
        id: 'a-novo',
        type: 'createCard',
        date: '',
        data: {
          list: { id: 'list-alvo', name: 'Lista Alvo' },
          card: { id: 'c1', name: 'Card' },
        },
      };
      const processSpy = jest
        .spyOn(service as any, 'processTriageForCard')
        .mockResolvedValue(undefined);
      await (service as unknown as TriageServicePrivate).handleAction(action);
      expect(processSpy).toHaveBeenCalledWith('c1');
    });
  });
});
