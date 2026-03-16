import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

jest.mock('node:util', () => ({
  promisify: jest.fn((fn: unknown) => fn),
}));

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

import { HealthController } from '../../src/health/health.controller';
import { execFile } from 'node:child_process';

const execFileAsyncMock = execFile as unknown as jest.Mock;

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const mockConfig = {
  getOrThrow: jest.fn((key: string) => {
    if (key === 'TRELLO_KEY') return 'test-key';
    if (key === 'TRELLO_TOKEN') return 'test-token';
    throw new Error(`Missing config: ${key}`);
  }),
  get: jest.fn((key: string, def?: string) => {
    if (key === 'CLAUDE_BIN') return 'claude';
    return def ?? '';
  }),
} as unknown as ConfigService;

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: ConfigService, useValue: mockConfig }],
    }).compile();
    controller = module.get(HealthController);
  });

  describe('check', () => {
    it('retorna status ok quando Trello e Claude estão saudáveis', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ username: 'meubot' }),
      });
      execFileAsyncMock.mockResolvedValue({ stdout: 'claude 1.2.3\n', stderr: '' });

      const result = await controller.check();

      expect(result.status).toBe('ok');
      expect((result.checks as any).trello.ok).toBe(true);
      expect((result.checks as any).claude.ok).toBe(true);
    });

    it('retorna status degraded quando Trello falha', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 });
      execFileAsyncMock.mockResolvedValue({ stdout: 'claude 1.2.3\n', stderr: '' });

      const result = await controller.check();

      expect(result.status).toBe('degraded');
      expect((result.checks as any).trello.ok).toBe(false);
    });

    it('retorna status degraded quando Claude falha', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ username: 'meubot' }),
      });
      execFileAsyncMock.mockRejectedValue(new Error('command not found: claude'));

      const result = await controller.check();

      expect(result.status).toBe('degraded');
      expect((result.checks as any).claude.ok).toBe(false);
    });

    it('retorna status degraded quando fetch do Trello lança erro', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      execFileAsyncMock.mockResolvedValue({ stdout: 'claude 1.2.3\n', stderr: '' });

      const result = await controller.check();

      expect(result.status).toBe('degraded');
      expect((result.checks as any).trello.ok).toBe(false);
      expect((result.checks as any).trello.message).toContain('ECONNREFUSED');
    });

    it('inclui timestamp no retorno', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ username: 'meubot' }),
      });
      execFileAsyncMock.mockResolvedValue({ stdout: 'claude 1.2.3\n', stderr: '' });

      const result = await controller.check();

      expect(typeof result.timestamp).toBe('string');
      expect(new Date(result.timestamp as string).getTime()).not.toBeNaN();
    });
  });

  describe('checkTrello', () => {
    it('retorna mensagem com username quando autenticado', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ username: 'meubot' }),
      });
      const result = await (controller as any).checkTrello();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('@meubot');
    });

    it('retorna ok false com status HTTP em caso de erro', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 });
      const result = await (controller as any).checkTrello();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('401');
    });
  });

  describe('checkClaude', () => {
    it('retorna mensagem com versão do Claude', async () => {
      execFileAsyncMock.mockResolvedValue({ stdout: '  claude 1.2.3  ', stderr: '' });
      const result = await (controller as any).checkClaude();
      expect(result.ok).toBe(true);
      expect(result.message).toBe('claude 1.2.3');
    });

    it('retorna ok false quando binário não é encontrado', async () => {
      execFileAsyncMock.mockRejectedValue(new Error('command not found'));
      const result = await (controller as any).checkClaude();
      expect(result.ok).toBe(false);
      expect(result.message).toContain('command not found');
    });
  });
});
