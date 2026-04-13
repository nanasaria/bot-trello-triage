export interface TrelloWebhookPayload {
  action: TrelloAction;
  model?: TrelloBoardRef;
}

export interface TrelloAction {
  id: string;
  type: string;
  date: string;
  data: TrelloActionData;
  memberCreator?: TrelloMember;
}

export interface TrelloActionData {
  card?: TrelloCardRef;
  list?: TrelloListRef;
  listBefore?: TrelloListRef;
  listAfter?: TrelloListRef;
  board?: TrelloBoardRef;
  old?: {
    idList?: string;
    closed?: boolean;
    [key: string]: unknown;
  };
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

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  closed?: boolean;
  labels: TrelloLabel[];
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

export interface TrelloComment {
  id: string;
  data: {
    text: string;
  };
  date: string;
  memberCreator: TrelloMember;
}

export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  isUpload: boolean;
  bytes: number;
  date: string;
}

export interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
}
