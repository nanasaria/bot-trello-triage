import { Module } from '@nestjs/common';
import { TriageService } from './triage.service.js';
import { TrelloModule } from '../trello/trello.module.js';
import { ClaudeModule } from '../claude/claude.module.js';

@Module({
  imports: [TrelloModule, ClaudeModule],
  providers: [TriageService],
  exports: [TriageService],
})
export class TriageModule {}
