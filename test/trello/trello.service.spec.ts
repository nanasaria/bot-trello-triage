import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TrelloService } from '../../src/trello/trello.service';
import type { TrelloAction, TrelloAttachment } from '../../src/trello/trello.types';

type TrelloServiceTestable = {
  normalizeName(name: string): string;
  buildCountedListName(currentName: string, count: number): string;
  shouldSyncListCounts(action: TrelloAction): boolean;
  buildUrl(path: string, params?: Record<string, string>): string;
  assertOk(res: Response, operation: string): Promise<void>;
  resolveTargetListIds(): Promise<string[]>;
  resolveCountedListIds(): Promise<string[]>;
  refreshCountedLists(): Promise<void>;
  countedListIds: string[];
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

jest.mock('mammoth', () => ({
  extractRawText: jest.fn().mockResolvedValue({ value: 'conteúdo do documento', messages: [] }),
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
    text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
  } as unknown as Response;
}

async function waitForAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TrelloService', () => {
  let service: TrelloService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [TrelloService, { provide: ConfigService, useValue: mockConfig }],
    }).compile();

    service = module.get(TrelloService);
  });

  describe('normalizeName', () => {
    it('remove acentos, sufixo numérico e espaços extras', () => {
      expect(
        (service as unknown as TrelloServiceTestable).normalizeName(
          '  Pendentes Análise - Chamados (03)  ',
        ),
      ).toBe('pendentes analise - chamados');
    });
  });

  describe('buildCountedListName', () => {
    it('preserva a largura do contador quando já existe no nome', () => {
      expect(
        (service as unknown as TrelloServiceTestable).buildCountedListName('Lotes (01)', 7),
      ).toBe('Lotes (07)');
    });

    it('usa contador sem padding quando a lista não possui sufixo numérico', () => {
      expect(
        (service as unknown as TrelloServiceTestable).buildCountedListName(
          'Pendentes Analise - Chamados',
          5,
        ),
      ).toBe('Pendentes Analise - Chamados (5)');
    });
  });

  describe('buildUrl', () => {
    it('inclui key, token e parâmetros extras na URL', () => {
      const url = (service as unknown as TrelloServiceTestable).buildUrl('/lists/list-1', {
        name: 'Lotes (07)',
      });

      expect(url).toContain('key=test-key');
      expect(url).toContain('token=test-token');
      expect(url).toContain('name=Lotes+%2807%29');
    });
  });

  describe('assertOk', () => {
    it('não lança erro quando a resposta é ok', async () => {
      await expect(
        (service as unknown as TrelloServiceTestable).assertOk(
          { ok: true } as Response,
          'buscar listas',
        ),
      ).resolves.toBeUndefined();
    });

    it('inclui status e body quando a API falha', async () => {
      const response = {
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue('Not Found'),
      } as unknown as Response;

      await expect(
        (service as unknown as TrelloServiceTestable).assertOk(response, 'buscar listas'),
      ).rejects.toThrow('HTTP 404');
      await expect(
        (service as unknown as TrelloServiceTestable).assertOk(response, 'buscar listas'),
      ).rejects.toThrow('Not Found');
    });
  });

  describe('fetchCardsInList', () => {
    it('filtra cards arquivados da resposta', async () => {
      fetchMock.mockResolvedValue(
        mockResponse([
          { id: 'c1', name: 'Card aberto', desc: '', idList: 'l1', labels: [], closed: false },
          { id: 'c2', name: 'Card arquivado', desc: '', idList: 'l1', labels: [], closed: true },
        ]),
      );

      const cards = await service.fetchCardsInList('l1');

      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe('c1');
    });
  });

  describe('fetchAttachments', () => {
    it('separa imagens, planilhas, documentos e vídeos corretamente', async () => {
      fetchMock.mockResolvedValue(
        mockResponse([
          {
            id: '1',
            name: 'foto.png',
            mimeType: 'image/png',
            url: 'u1',
            isUpload: true,
            bytes: 100,
            date: '',
          },
          {
            id: '2',
            name: 'dados.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            url: 'u2',
            isUpload: true,
            bytes: 200,
            date: '',
          },
          {
            id: '3',
            name: 'video.mp4',
            mimeType: 'video/mp4',
            url: 'u3',
            isUpload: true,
            bytes: 300,
            date: '',
          },
          {
            id: '4',
            name: 'relatorio.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            url: 'u4',
            isUpload: true,
            bytes: 400,
            date: '',
          },
        ]),
      );

      const result = await service.fetchAttachments('card-1');

      expect(result.images).toHaveLength(1);
      expect(result.spreadsheets).toHaveLength(1);
      expect(result.documents).toHaveLength(1);
      expect(result.videos).toHaveLength(1);
    });
  });

  describe('hasTriageComment', () => {
    it('retorna true quando já existe comentário do bot', async () => {
      fetchMock.mockResolvedValue(
        mockResponse([
          {
            id: 'comment-1',
            data: { text: '[Análise técnica automática]\nconteúdo' },
            date: '',
            memberCreator: {},
          },
        ]),
      );

      await expect(service.hasTriageComment('card-1')).resolves.toBe(true);
    });
  });

  describe('resolveTargetListIds', () => {
    it('usa o ID explícito quando TRELLO_TARGET_LIST_ID está configurado', async () => {
      mockConfig.get.mockImplementation((key: string, def?: string) => {
        if (key === 'TRELLO_TARGET_LIST_ID') return 'list-explicit';
        return def ?? '';
      });

      await expect(
        (service as unknown as TrelloServiceTestable).resolveTargetListIds(),
      ).resolves.toEqual(['list-explicit']);
    });

    it('resolve as duas listas de triagem pelos prefixos configurados', async () => {
      mockConfig.get.mockImplementation((key: string, def?: string) => {
        if (key === 'TRELLO_TARGET_LIST_ID') return '';
        if (key === 'TRELLO_TARGET_LIST_PREFIXES') {
          return 'Pendentes Analise - Chamados,Lotes';
        }
        return def ?? '';
      });

      fetchMock.mockResolvedValue(
        mockResponse([
          { id: 'list-1', name: 'Pendentes Analise - Chamados (5)', closed: false },
          { id: 'list-2', name: 'Lotes (01)', closed: false },
          { id: 'list-3', name: 'Outro fluxo', closed: false },
        ]),
      );

      await expect(
        (service as unknown as TrelloServiceTestable).resolveTargetListIds(),
      ).resolves.toEqual(['list-1', 'list-2']);
    });
  });

  describe('resolveCountedListIds', () => {
    it('resolve todas as listas monitoradas para contador', async () => {
      mockConfig.get.mockImplementation((key: string, def?: string) => {
        if (key === 'TRELLO_COUNTED_LIST_PREFIXES') {
          return [
            'Pendentes Analise - Chamados',
            'Lotes',
            'Em tratativa com Devs',
            'Pendente publicar',
            'Pendentes Resposta Tia Tati/Tia Regi',
          ].join(',');
        }

        return def ?? '';
      });

      fetchMock.mockResolvedValue(
        mockResponse([
          { id: 'list-1', name: 'Pendentes Analise - Chamados (5)', closed: false },
          { id: 'list-2', name: 'Lotes (01)', closed: false },
          { id: 'list-3', name: 'Em tratativa com Devs (06)', closed: false },
          { id: 'list-4', name: 'Pendente publicar (02)', closed: false },
          {
            id: 'list-5',
            name: 'Pendentes Resposta Tia Tati/Tia Regi (01)',
            closed: false,
          },
        ]),
      );

      await expect(
        (service as unknown as TrelloServiceTestable).resolveCountedListIds(),
      ).resolves.toEqual(['list-1', 'list-2', 'list-3', 'list-4', 'list-5']);
    });
  });

  describe('shouldSyncListCounts', () => {
    it('retorna true para updateCard com mudança de closed', () => {
      const action: TrelloAction = {
        id: 'action-1',
        type: 'updateCard',
        date: '',
        data: {
          old: { closed: false },
        },
      };

      expect(
        (service as unknown as TrelloServiceTestable).shouldSyncListCounts(action),
      ).toBe(true);
    });

    it('ignora ações que não alteram contagem', () => {
      const action: TrelloAction = {
        id: 'action-1',
        type: 'commentCard',
        date: '',
        data: {},
      };

      expect(
        (service as unknown as TrelloServiceTestable).shouldSyncListCounts(action),
      ).toBe(false);
    });
  });

  describe('scheduleListCountSync', () => {
    it('agenda a sincronização para ações relevantes', async () => {
      const refreshSpy = jest
        .spyOn(service as any, 'refreshCountedLists')
        .mockResolvedValue(undefined);

      service.scheduleListCountSync({
        id: 'action-1',
        type: 'updateCard',
        date: '',
        data: {
          old: { idList: 'list-1' },
        },
      });

      await waitForAsyncWork();

      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it('não agenda sincronização para ações irrelevantes', async () => {
      const refreshSpy = jest
        .spyOn(service as any, 'refreshCountedLists')
        .mockResolvedValue(undefined);

      service.scheduleListCountSync({
        id: 'action-1',
        type: 'commentCard',
        date: '',
        data: {},
      });

      await waitForAsyncWork();

      expect(refreshSpy).not.toHaveBeenCalled();
    });
  });

  describe('refreshCountedLists', () => {
    it('recalcula a quantidade e renomeia só as listas que mudaram', async () => {
      (service as unknown as TrelloServiceTestable).countedListIds = ['list-1', 'list-2'];

      fetchMock
        .mockResolvedValueOnce(
          mockResponse([
            { id: 'list-1', name: 'Lotes (01)', closed: false },
            { id: 'list-2', name: 'Pendente publicar (02)', closed: false },
          ]),
        )
        .mockResolvedValueOnce(
          mockResponse([
            { id: 'card-1', name: 'A', desc: '', idList: 'list-1', labels: [], closed: false },
            { id: 'card-2', name: 'B', desc: '', idList: 'list-1', labels: [], closed: false },
            { id: 'card-3', name: 'C', desc: '', idList: 'list-1', labels: [], closed: true },
          ]),
        )
        .mockResolvedValueOnce(mockResponse({}))
        .mockResolvedValueOnce(
          mockResponse([
            { id: 'card-4', name: 'D', desc: '', idList: 'list-2', labels: [], closed: false },
            { id: 'card-5', name: 'E', desc: '', idList: 'list-2', labels: [], closed: false },
          ]),
        );

      await (service as unknown as TrelloServiceTestable).refreshCountedLists();

      expect(fetchMock).toHaveBeenCalledTimes(4);

      const putCall = fetchMock.mock.calls.find(
        ([url, options]) =>
          String(url).includes('/lists/list-1') && (options as RequestInit)?.method === 'PUT',
      );

      expect(putCall).toBeDefined();
      expect(String(putCall?.[0])).toContain('name=Lotes+%2802%29');

      const secondListPutCall = fetchMock.mock.calls.find(
        ([url, options]) =>
          String(url).includes('/lists/list-2') && (options as RequestInit)?.method === 'PUT',
      );

      expect(secondListPutCall).toBeUndefined();
    });
  });

  describe('downloadWordDocumentAsText', () => {
    it('baixa o arquivo com autenticação OAuth', async () => {
      const attachment: TrelloAttachment = {
        id: 'att-1',
        name: 'relatorio.docx',
        url: 'https://trello.com/1/cards/c1/attachments/att-1/download/relatorio.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        isUpload: true,
        bytes: 1024,
        date: '',
      };

      fetchMock.mockResolvedValue(mockResponse(new ArrayBuffer(8)));

      await service.downloadWordDocumentAsText(attachment);

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>).Authorization).toContain(
        'oauth_consumer_key',
      );
    });
  });
});
