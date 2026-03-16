import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { TrelloController } from '../../src/trello/trello.controller';
import { TriageService } from '../../src/triage/triage.service';
import { ConfigService } from '@nestjs/config';

const WEBHOOK_SECRET = 'test-oauth-secret';
const CALLBACK_URL = 'https://test.ngrok.app/trello/webhook';

const mockTriageService = { enqueue: jest.fn() } as unknown as TriageService;

const mockConfig = {
  getOrThrow: jest.fn((key: string) => {
    if (key === 'TRELLO_OAUTH_SECRET') return WEBHOOK_SECRET;
    if (key === 'TRELLO_WEBHOOK_CALLBACK_URL') return CALLBACK_URL;
    throw new Error(`Missing config: ${key}`);
  }),
  get: jest.fn(),
} as unknown as ConfigService;

function makeSignature(rawBody: Buffer): string {
  return createHmac('sha1', WEBHOOK_SECRET)
    .update(CALLBACK_URL)
    .update(rawBody)
    .digest('base64');
}

describe('TrelloController', () => {
  let controller: TrelloController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new TrelloController(mockTriageService, mockConfig);
  });

  describe('validateWebhook', () => {
    it('executa sem lançar erros', () => {
      expect(() => controller.validateWebhook()).not.toThrow();
    });
  });

  describe('receiveWebhook', () => {
    it('enfileira a action quando payload é válido', () => {
      (mockConfig.get as jest.Mock).mockReturnValue('true');
      const action = { id: 'a1', type: 'createCard', date: '', data: {} };
      const req = { rawBody: Buffer.from('{}') } as any;
      controller.receiveWebhook(req, { action } as any, 'sig');
      expect(mockTriageService.enqueue).toHaveBeenCalledWith(action);
    });

    it('ignora webhook sem campo action', () => {
      (mockConfig.get as jest.Mock).mockReturnValue('true');
      const req = { rawBody: Buffer.from('{}') } as any;
      controller.receiveWebhook(req, {} as any, 'sig');
      expect(mockTriageService.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('verifySignature', () => {
    it('pula verificação quando TRELLO_SKIP_SIGNATURE é true', () => {
      (mockConfig.get as jest.Mock).mockReturnValue('true');
      expect(() =>
        (controller as any).verifySignature(Buffer.from('body'), 'invalida'),
      ).not.toThrow();
    });

    it('lança UnauthorizedException quando assinatura está ausente', () => {
      (mockConfig.get as jest.Mock).mockReturnValue('false');
      expect(() =>
        (controller as any).verifySignature(Buffer.from('body'), ''),
      ).toThrow(UnauthorizedException);
    });

    it('lança UnauthorizedException quando rawBody está vazio', () => {
      (mockConfig.get as jest.Mock).mockReturnValue('false');
      expect(() =>
        (controller as any).verifySignature(undefined, 'sig'),
      ).toThrow(UnauthorizedException);
    });

    it('aceita assinatura HMAC correta', () => {
      (mockConfig.get as jest.Mock).mockReturnValue('false');
      const rawBody = Buffer.from('{"test":true}');
      const validSig = makeSignature(rawBody);
      expect(() =>
        (controller as any).verifySignature(rawBody, validSig),
      ).not.toThrow();
    });

    it('lança UnauthorizedException para assinatura HMAC inválida', () => {
      (mockConfig.get as jest.Mock).mockReturnValue('false');
      const rawBody = Buffer.from('{"test":true}');
      expect(() =>
        (controller as any).verifySignature(rawBody, 'assinatura-errada'),
      ).toThrow(UnauthorizedException);
    });
  });
});
