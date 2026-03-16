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
  private readonly webhookSecret: string;
  private readonly callbackUrl: string;

  constructor(
    private readonly triageService: TriageService,
    private readonly config: ConfigService,
  ) {
    this.webhookSecret = this.config.getOrThrow<string>('TRELLO_OAUTH_SECRET');
    this.callbackUrl = this.config.getOrThrow<string>('TRELLO_WEBHOOK_CALLBACK_URL');
  }

  @Head('webhook')
  @HttpCode(200)
  validateWebhook(): void {}

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
