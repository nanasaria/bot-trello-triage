import {
  Controller,
  Head,
  Post,
  Body,
  Req,
  HttpCode,
  Logger,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { TriageService } from '../triage/triage.service.js';
import type { TrelloWebhookPayload } from './trello.types.js';

@Controller('trello')
export class TrelloController {
  private readonly logger = new Logger(TrelloController.name);
  // O Trello usa o OAuth Secret (não o token) para assinar os webhooks.
  // Obtenha em: https://trello.com/app-key → campo "Secret"
  private readonly webhookSecret: string;
  private readonly callbackUrl: string;

  constructor(
    private readonly triageService: TriageService,
    private readonly config: ConfigService,
  ) {
    this.webhookSecret = this.config.getOrThrow<string>('TRELLO_OAUTH_SECRET');
    this.callbackUrl = this.config.getOrThrow<string>('TRELLO_WEBHOOK_CALLBACK_URL');
  }

  // O Trello exige que o endpoint responda 200 a um HEAD antes de registrar o webhook.
  @Head('webhook')
  @HttpCode(200)
  validateWebhook(): void {}

  // Recebe eventos do Trello. Valida a assinatura HMAC usando o raw body
  // (antes do JSON.parse), enfileira e responde 200 imediatamente.
  @Post('webhook')
  @HttpCode(200)
  receiveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: TrelloWebhookPayload,
    @Headers('x-trello-webhook') signature: string,
  ): void {
    this.verifySignature(req.rawBody, signature);

    if (!payload?.action) {
      this.logger.warn('Webhook recebido sem campo action, ignorando');
      return;
    }

    this.triageService.enqueue(payload.action);
    this.logger.debug(`ActionId ${payload.action.id} enfileirado`);
  }

  // Valida a assinatura HMAC-SHA1 do Trello usando o raw body exato recebido.
  // Fórmula: Base64( HMAC-SHA1( callbackURL + rawBody, TRELLO_OAUTH_SECRET ) )
  // Definir TRELLO_SKIP_SIGNATURE=true no .env para desabilitar em desenvolvimento.
  private verifySignature(rawBody: Buffer | undefined, signature: string): void {
    const skip = this.config.get<string>('TRELLO_SKIP_SIGNATURE') === 'true';
    if (skip) return;

    if (!signature) {
      throw new UnauthorizedException('Header x-trello-webhook ausente');
    }

    if (!rawBody?.length) {
      throw new UnauthorizedException('Body vazio — impossível verificar assinatura');
    }

    const expected = createHmac('sha1', this.webhookSecret)
      .update(this.callbackUrl)
      .update(rawBody)
      .digest('base64');

    if (expected !== signature) {
      this.logger.warn('Assinatura do webhook inválida — request rejeitado');
      throw new UnauthorizedException('Assinatura do webhook inválida');
    }
  }
}
