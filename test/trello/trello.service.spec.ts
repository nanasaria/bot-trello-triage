import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TrelloService } from '../../src/trello/trello.service';
import type { TrelloAttachment } from '../../src/trello/trello.types';

type TrelloServiceTestable = {
  normalizeName(name: string): string;
  isSpreadsheet(attachment: Pick<TrelloAttachment, 'mimeType' | 'name'>): boolean;
  buildUrl(path: string, params?: Record<string, string>): string;
  assertOk(res: Response, operation: string): Promise<void>;
  resolveTargetListId(): Promise<string>;
  targetListId: string | null;
};

jest.mock('node:fs/promises', () => ({
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('xlsx', () => ({
  read: jest.fn().mockReturnValue({
    SheetNames: ['Aba1'],
    Sheets: { Aba1: {} },
  }),
  utils: {
    sheet_to_csv: jest.fn().mockReturnValue('col1,col2\nval1,val2'),
  },
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const mockConfig = {
  get: jest.fn((key: string, def?: string) => def ?? ''),
  getOrThrow: jest.fn((key: string) => {
    const values: Record<string, string> = {
      TRELLO_KEY: 'test-key',
      TRELLO_TOKEN: 'test-token',
      TRELLO_BOARD_ID: 'board-123',
    };
    if (values[key]) return values[key];
    throw new Error(`Missing required config: ${key}`);
  }),
};

function mockResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(String(body)),
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
  } as unknown as Response;
}

describe('TrelloService', () => {
  let service: TrelloService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        TrelloService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get(TrelloService);
  });

  describe('normalizeName', () => {
    it('remove acentos', () => {
      expect((service as unknown as TrelloServiceTestable).normalizeName('Análise Técnica')).toBe(
        'analise tecnica',
      );
    });

    it('remove sufixo numérico entre parênteses', () => {
      expect(
        (service as unknown as TrelloServiceTestable).normalizeName('Pendentes Analise - Chamados (03)'),
      ).toBe('pendentes analise - chamados');
    });

    it('converte para minúsculas', () => {
      expect((service as unknown as TrelloServiceTestable).normalizeName('LISTA CHAMADOS')).toBe(
        'lista chamados',
      );
    });

    it('normaliza espaços extras', () => {
      expect((service as unknown as TrelloServiceTestable).normalizeName('  lista   dois  ')).toBe(
        'lista dois',
      );
    });
  });

  describe('isSpreadsheet', () => {
    it('reconhece XLSX por mimeType', () => {
      expect(
        (service as unknown as TrelloServiceTestable).isSpreadsheet({
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          name: 'arquivo',
        }),
      ).toBe(true);
    });

    it('reconhece XLS por mimeType', () => {
      expect(
        (service as unknown as TrelloServiceTestable).isSpreadsheet({
          mimeType: 'application/vnd.ms-excel',
          name: 'arquivo',
        }),
      ).toBe(true);
    });

    it('reconhece CSV por mimeType', () => {
      expect(
        (service as unknown as TrelloServiceTestable).isSpreadsheet({
          mimeType: 'text/csv',
          name: 'arquivo',
        }),
      ).toBe(true);
    });

    it('reconhece .xlsx por extensão quando mimeType é vazio', () => {
      expect(
        (service as unknown as TrelloServiceTestable).isSpreadsheet({ mimeType: '', name: 'dados.xlsx' }),
      ).toBe(true);
    });

    it('reconhece .xls por extensão', () => {
      expect(
        (service as unknown as TrelloServiceTestable).isSpreadsheet({ mimeType: '', name: 'dados.xls' }),
      ).toBe(true);
    });

    it('reconhece .csv por extensão', () => {
      expect(
        (service as unknown as TrelloServiceTestable).isSpreadsheet({ mimeType: '', name: 'dados.csv' }),
      ).toBe(true);
    });

    it('rejeita imagem PNG', () => {
      expect(
        (service as unknown as TrelloServiceTestable).isSpreadsheet({
          mimeType: 'image/png',
          name: 'foto.png',
        }),
      ).toBe(false);
    });

    it('rejeita PDF', () => {
      expect(
        (service as unknown as TrelloServiceTestable).isSpreadsheet({
          mimeType: 'application/pdf',
          name: 'doc.pdf',
        }),
      ).toBe(false);
    });
  });

  describe('buildUrl', () => {
    it('inclui key e token nos parâmetros', () => {
      const url = (service as unknown as TrelloServiceTestable).buildUrl('/cards/123');
      expect(url).toContain('key=test-key');
      expect(url).toContain('token=test-token');
    });

    it('inclui parâmetros extras', () => {
      const url = (service as unknown as TrelloServiceTestable).buildUrl('/cards/123', {
        checklists: 'all',
      });
      expect(url).toContain('checklists=all');
    });

    it('constrói URL com o path correto', () => {
      const url = (service as unknown as TrelloServiceTestable).buildUrl('/boards/board-123/lists');
      expect(url).toContain('/boards/board-123/lists');
    });
  });

  describe('assertOk', () => {
    it('não lança erro quando resposta é ok', async () => {
      const res = { ok: true } as Response;
      await expect(
        (service as unknown as TrelloServiceTestable).assertOk(res, 'buscar card'),
      ).resolves.toBeUndefined();
    });

    it('lança erro com status HTTP quando resposta não é ok', async () => {
      const res = {
        ok: false,
        status: 401,
        text: jest.fn().mockResolvedValue('Unauthorized'),
      } as unknown as Response;
      await expect(
        (service as unknown as TrelloServiceTestable).assertOk(res, 'buscar card'),
      ).rejects.toThrow('HTTP 401');
    });

    it('inclui o body do erro na mensagem', async () => {
      const res = {
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue('Not Found'),
      } as unknown as Response;
      await expect(
        (service as unknown as TrelloServiceTestable).assertOk(res, 'buscar card'),
      ).rejects.toThrow('Not Found');
    });
  });

  describe('fetchCard', () => {
    it('retorna o card parseado', async () => {
      const card = { id: 'c1', name: 'Bug', desc: 'desc', labels: [] };
      fetchMock.mockResolvedValue(mockResponse(card));
      const result = await service.fetchCard('c1');
      expect(result).toEqual(card);
    });

    it('lança erro quando API retorna status de erro', async () => {
      fetchMock.mockResolvedValue(mockResponse(null, false, 404));
      await expect(service.fetchCard('c1')).rejects.toThrow('HTTP 404');
    });
  });

  describe('fetchAttachments', () => {
    it('separa imagens e planilhas corretamente', async () => {
      fetchMock.mockResolvedValue(
        mockResponse([
          { id: '1', name: 'foto.png', mimeType: 'image/png', url: 'u1', isUpload: true, bytes: 100, date: '' },
          { id: '2', name: 'dados.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', url: 'u2', isUpload: true, bytes: 200, date: '' },
          { id: '3', name: 'video.mp4', mimeType: 'video/mp4', url: 'u3', isUpload: true, bytes: 300, date: '' },
        ]),
      );
      const result = await service.fetchAttachments('c1');
      expect(result.images).toHaveLength(1);
      expect(result.images[0].name).toBe('foto.png');
      expect(result.spreadsheets).toHaveLength(1);
      expect(result.spreadsheets[0].name).toBe('dados.xlsx');
    });
  });

  describe('hasTriageComment', () => {
    it('retorna true quando comentário de triagem existe', async () => {
      fetchMock.mockResolvedValue(
        mockResponse([
          {
            id: '1',
            data: { text: '[Análise técnica automática]\nconteúdo' },
            date: '',
            memberCreator: {},
          },
        ]),
      );
      await expect(service.hasTriageComment('c1')).resolves.toBe(true);
    });

    it('retorna false quando não há comentário de triagem', async () => {
      fetchMock.mockResolvedValue(
        mockResponse([
          {
            id: '1',
            data: { text: 'comentário comum' },
            date: '',
            memberCreator: {},
          },
        ]),
      );
      await expect(service.hasTriageComment('c1')).resolves.toBe(false);
    });

    it('retorna false quando não há comentários', async () => {
      fetchMock.mockResolvedValue(mockResponse([]));
      await expect(service.hasTriageComment('c1')).resolves.toBe(false);
    });
  });

  describe('getTargetListId', () => {
    it('retorna TRELLO_TARGET_LIST_ID quando configurado explicitamente', async () => {
      mockConfig.get.mockImplementation((key: string, def?: string) => {
        if (key === 'TRELLO_TARGET_LIST_ID') return 'list-explicit';
        return def ?? '';
      });
      const result = await (service as unknown as TrelloServiceTestable).resolveTargetListId();
      expect(result).toBe('list-explicit');
    });

    it('busca lista pelo prefixo quando ID não está configurado', async () => {
      mockConfig.get.mockImplementation((key: string, def?: string) => {
        if (key === 'TRELLO_TARGET_LIST_ID') return '';
        if (key === 'TRELLO_TARGET_LIST_PREFIX') return 'Pendentes Analise';
        return def ?? '';
      });
      fetchMock.mockResolvedValue(
        mockResponse([
          { id: 'list-found', name: 'Pendentes Analise - Chamados (03)', closed: false },
        ]),
      );
      const result = await (service as unknown as TrelloServiceTestable).resolveTargetListId();
      expect(result).toBe('list-found');
    });

    it('lança erro quando nenhuma lista corresponde ao prefixo', async () => {
      mockConfig.get.mockImplementation((key: string, def?: string) => {
        if (key === 'TRELLO_TARGET_LIST_ID') return '';
        if (key === 'TRELLO_TARGET_LIST_PREFIX') return 'Prefixo Inexistente';
        return def ?? '';
      });
      fetchMock.mockResolvedValue(
        mockResponse([{ id: 'l1', name: 'Outra Lista', closed: false }]),
      );
      await expect(
        (service as unknown as TrelloServiceTestable).resolveTargetListId(),
      ).rejects.toThrow('Nenhuma lista encontrada');
    });

    it('usa cache na segunda chamada', async () => {
      (service as unknown as TrelloServiceTestable).targetListId = 'list-cached';
      const result = await service.getTargetListId();
      expect(result).toBe('list-cached');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
