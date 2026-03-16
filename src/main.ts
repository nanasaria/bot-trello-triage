import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error', 'debug'],
    // rawBody: true expõe req.rawBody no controller — necessário para validar
    // a assinatura HMAC do Trello usando o body exato recebido (sem re-serializar)
    rawBody: true,
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Bot de triagem rodando na porta ${port}`);
  logger.log(`Webhook endpoint: POST /trello/webhook`);
}

bootstrap().catch((err) => {
  console.error('Falha crítica ao iniciar a aplicação:', err);
  process.exit(1);
});
