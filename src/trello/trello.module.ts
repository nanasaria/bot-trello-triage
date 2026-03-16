import { Module } from '@nestjs/common';
import { TrelloService } from './trello.service.js';

// TrelloModule é independente — apenas provê e exporta TrelloService.
// TrelloController NÃO fica aqui para evitar dependência circular com TriageModule.
// O controller é registrado no AppModule, que importa ambos os módulos.
@Module({
  providers: [TrelloService],
  exports: [TrelloService],
})
export class TrelloModule {}
