import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TrelloModule } from './trello/trello.module.js';
import { TriageModule } from './triage/triage.module.js';
import { ClaudeModule } from './claude/claude.module.js';
import { HealthModule } from './health/health.module.js';
import { TrelloController } from './trello/trello.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    TrelloModule,
    TriageModule,
    ClaudeModule,
    HealthModule,
  ],
  controllers: [TrelloController],
})
export class AppModule {}
