import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TriageService } from '../../src/triage/triage.service';
import { TrelloService } from '../../src/trello/trello.service';
import { ClaudeService } from '../../src/claude/claude.service';
import type { TrelloAction } from '../../src/trello/trello.types';

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
  fetchAttachments: jest.fn().mockResolvedValue({ images: [], spreadsheets: [] }),
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
      expect((service as any).extractTargetListId(action)).toBe('list-1');
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
      expect((service as any).extractTargetListId(action)).toBe('list-2');
    });

    it('retorna null para updateCard sem listAfter', () => {
      const action: TrelloAction = {
        id: 'a1',
        type: 'updateCard',
        date: '',
        data: { card: { id: 'c1', name: 'Card' } },
      };
      expect((service as any).extractTargetListId(action)).toBeNull();
    });

    it('retorna null para tipos não tratados', () => {
      const action: TrelloAction = {
        id: 'a1',
        type: 'commentCard',
        date: '',
        data: {},
      };
      expect((service as any).extractTargetListId(action)).toBeNull();
    });
  });

  describe('resolveRepoPath', () => {
    it('retorna caminho pelo mapeamento de label', () => {
      expect((service as any).resolveRepoPath(['bug', 'repo:api'])).toBe(
        '/srv/api',
      );
    });

    it('retorna defaultRepoPath quando nenhuma label repo: é encontrada', () => {
      expect((service as any).resolveRepoPath(['bug', 'frontend'])).toBe(
        '/srv/default',
      );
    });

    it('retorna null quando não há label e defaultRepoPath está vazio', () => {
      (service as any).defaultRepoPath = '';
      expect((service as any).resolveRepoPath([])).toBeNull();
    });

    it('ignora label repo: que não está no mapa', () => {
      expect((service as any).resolveRepoPath(['repo:desconhecido'])).toBe(
        '/srv/default',
      );
    });
  });

  describe('formatTriageComment', () => {
    it('inclui o cabeçalho obrigatório', () => {
      const result = (service as any).formatTriageComment({
        hipoteseInicial: 'Hipótese',
        arquivosCandidatos: ['src/app.ts'],
        proximosPassosSugeridos: ['Passo 1'],
      });
      expect(result).toContain('[Análise técnica automática]');
    });

    it('formata arquivos candidatos como lista', () => {
      const result = (service as any).formatTriageComment({
        hipoteseInicial: 'Hipótese',
        arquivosCandidatos: ['src/a.ts', 'src/b.ts'],
        proximosPassosSugeridos: [],
      });
      expect(result).toContain('- src/a.ts');
      expect(result).toContain('- src/b.ts');
    });

    it('formata próximos passos numerados', () => {
      const result = (service as any).formatTriageComment({
        hipoteseInicial: 'Hipótese',
        arquivosCandidatos: [],
        proximosPassosSugeridos: ['Verificar logs', 'Testar endpoint'],
      });
      expect(result).toContain('1. Verificar logs');
      expect(result).toContain('2. Testar endpoint');
    });

    it('usa mensagem padrão quando não há arquivos candidatos', () => {
      const result = (service as any).formatTriageComment({
        hipoteseInicial: 'Hipótese',
        arquivosCandidatos: [],
        proximosPassosSugeridos: [],
      });
      expect(result).toContain('Nenhum arquivo específico identificado');
    });
  });

  describe('trackActionId', () => {
    it('adiciona actionId ao mapa', () => {
      (service as any).trackActionId('action-1');
      expect((service as any).processedActionIds.has('action-1')).toBe(true);
    });

    it('remove o mais antigo quando o limite é atingido', () => {
      const max: number = (service as any).PROCESSED_IDS_MAX;
      for (let i = 0; i < max; i++) {
        (service as any).trackActionId(`action-${i}`);
      }
      (service as any).trackActionId('action-nova');
      expect((service as any).processedActionIds.has('action-0')).toBe(false);
      expect((service as any).processedActionIds.has('action-nova')).toBe(true);
      expect((service as any).processedActionIds.size).toBe(max);
    });
  });

  describe('parseRepoLabelMap', () => {
    it('carrega o mapa do REPO_LABEL_MAP corretamente', () => {
      expect((service as any).repoLabelMap).toEqual({ 'repo:api': '/srv/api' });
    });

    it('retorna mapa vazio quando REPO_LABEL_MAP é JSON inválido', () => {
      const invalidConfig = {
        get: jest.fn((key: string, def?: string) => {
          if (key === 'REPO_LABEL_MAP') return 'não é json';
          return def ?? '';
        }),
      };
      const svc = new TriageService(
        mockTrelloService as any,
        mockClaudeService as any,
        invalidConfig as any,
      );
      expect((svc as any).repoLabelMap).toEqual({});
    });

    it('retorna mapa vazio quando REPO_LABEL_MAP é um array', () => {
      const arrayConfig = {
        get: jest.fn((key: string, def?: string) => {
          if (key === 'REPO_LABEL_MAP') return '["não é objeto"]';
          return def ?? '';
        }),
      };
      const svc = new TriageService(
        mockTrelloService as any,
        mockClaudeService as any,
        arrayConfig as any,
      );
      expect((svc as any).repoLabelMap).toEqual({});
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
      (service as any).processedActionIds.set('a-dup', true);
      const action: TrelloAction = {
        id: 'a-dup',
        type: 'createCard',
        date: '',
        data: { list: { id: 'list-alvo', name: 'Lista' }, card: { id: 'c1', name: 'Card' } },
      };
      await (service as any).handleAction(action);
      expect(mockTrelloService.getTargetListId).not.toHaveBeenCalled();
    });

    it('ignora action de lista diferente da alvo', async () => {
      const action: TrelloAction = {
        id: 'a1',
        type: 'createCard',
        date: '',
        data: { list: { id: 'outra-lista', name: 'Outra' }, card: { id: 'c1', name: 'Card' } },
      };
      const processSpy = jest
        .spyOn(service as any, 'processTriageForCard')
        .mockResolvedValue(undefined);
      await (service as any).handleAction(action);
      expect(processSpy).not.toHaveBeenCalled();
    });

    it('chama processTriageForCard para ação na lista alvo', async () => {
      const action: TrelloAction = {
        id: 'a-novo',
        type: 'createCard',
        date: '',
        data: { list: { id: 'list-alvo', name: 'Lista Alvo' }, card: { id: 'c1', name: 'Card' } },
      };
      const processSpy = jest
        .spyOn(service as any, 'processTriageForCard')
        .mockResolvedValue(undefined);
      await (service as any).handleAction(action);
      expect(processSpy).toHaveBeenCalledWith('c1');
    });
  });
});
