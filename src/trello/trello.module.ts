import { Module } from '@nestjs/common';
import { TrelloService } from './trello.service.js';

@Module({
  providers: [TrelloService],
  exports: [TrelloService],
})
export class TrelloModule {}
