// Payload enviado pelo webhook do Trello a cada evento
export interface TrelloWebhookPayload {
  action: TrelloAction;
  model?: TrelloBoardRef;
}

// Representa uma ação registrada pelo Trello (criação, atualização, comentário, etc.)
export interface TrelloAction {
  id: string;
  type: string;
  date: string;
  data: TrelloActionData;
  memberCreator?: TrelloMember;
}

// Dados contextuais da ação — campos variam conforme o tipo da ação
export interface TrelloActionData {
  card?: TrelloCardRef;
  list?: TrelloListRef; // presente em createCard
  listBefore?: TrelloListRef; // presente em updateCard (movimentação)
  listAfter?: TrelloListRef; // presente em updateCard (movimentação)
  board?: TrelloBoardRef;
  old?: Record<string, unknown>;
}

export interface TrelloCardRef {
  id: string;
  name: string;
  idShort?: number;
}

export interface TrelloListRef {
  id: string;
  name: string;
}

export interface TrelloBoardRef {
  id: string;
  name: string;
}

export interface TrelloMember {
  id: string;
  fullName: string;
  username: string;
}

// Card completo retornado pela API GET /cards/:id
export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  labels: TrelloLabel[];
  // checklists são carregados opcionalmente via ?checklists=all
  checklists?: TrelloChecklist[];
}

export interface TrelloLabel {
  id: string;
  name: string;
  color: string;
}

export interface TrelloChecklist {
  id: string;
  name: string;
  checkItems: TrelloCheckItem[];
}

export interface TrelloCheckItem {
  id: string;
  name: string;
  state: 'complete' | 'incomplete';
}

// Comentário retornado pelo endpoint de ações do card filtrado por tipo commentCard
export interface TrelloComment {
  id: string;
  data: {
    text: string;
  };
  date: string;
  memberCreator: TrelloMember;
}

// Anexo retornado pela API GET /cards/:id/attachments
export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  isUpload: boolean;
  bytes: number;
  date: string;
}

// Lista do board (usada para resolver o ID alvo)
export interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
}
