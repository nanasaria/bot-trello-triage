# bot-triagem-trello

Bot de triagem técnica automática para cards do Trello. Quando um card é criado ou movido para uma das listas de triagem (por padrão `Pendentes Analise - Chamados` e `Lotes`), o bot aguarda 2 minutos e 30 segundos, analisa o card com o Claude CLI no repositório local e posta um comentário estruturado com hipótese inicial, arquivos candidatos e próximos passos. O mesmo webhook também recalcula a quantidade de cards e atualiza o nome das listas monitoradas. Se o Claude responder que atingiu o limite de uso, o bot pode fazer fallback automático para a OpenAI quando `OPENAI_API_KEY` estiver configurada.

## Como funciona

1. O Trello envia um evento via webhook para o bot
2. O bot recalcula as listas monitoradas para contador e atualiza o nome delas com a quantidade de cards
3. O bot identifica se o card foi criado ou movido para uma das listas de triagem configuradas
4. Após 2 minutos e 30 segundos, baixa os dados do card (título, descrição, checklists, comentários, imagens, planilhas XLSX e documentos Word)
5. Executa o Claude CLI no diretório do repositório local mapeado pela label do card
6. Se o Claude informar que atingiu o limite de uso, o bot usa a OpenAI como fallback opcional
7. Posta um comentário de triagem no card com o resultado da análise

## Pré-requisitos

- **Node.js 18+**
- **Claude Code CLI** instalado e autenticado (`claude --version` deve funcionar)
- **OpenAI API Key** opcional, caso você queira habilitar fallback automático quando o Claude atingir o limite
- **ffmpeg** instalado no sistema (necessário para processar vídeos anexados aos cards)
- **ngrok** para expor o servidor localmente ao Trello
- Conta no Trello com API Key, Token e OAuth Secret

## Instalação do Claude Code CLI

O Claude Code CLI é necessário para executar a análise de triagem no repositório local.

1. Instale via npm:

   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. Autentique com sua conta Anthropic:

   ```bash
   claude
   ```

   Na primeira execução, o CLI abrirá o fluxo de autenticação no navegador.

3. Verifique a instalação:

   ```bash
   claude --version
   ```

4. Configure o caminho do binário no `.env` se necessário. Por padrão `CLAUDE_BIN=claude` funciona se o CLI estiver no PATH. Caso contrário, informe o caminho completo:

   ```env
   CLAUDE_BIN=/caminho/completo/para/claude
   ```

## Instalação do ngrok

O ngrok é necessário para que o Trello consiga enviar webhooks para o seu servidor local.

1. Acesse [ngrok.com/download](https://ngrok.com/download) e baixe a versão para seu sistema operacional
2. Autentique o ngrok com seu token (obtenha em [dashboard.ngrok.com](https://dashboard.ngrok.com)):

   ```bash
   ngrok config add-authtoken SEU_TOKEN_AQUI
   ```

3. Inicie o túnel na porta do servidor (padrão 3080):

   ```bash
   ngrok http 3080
   ```

4. Copie a URL pública gerada (ex: `https://xxxx-xxxx.ngrok-free.app`) — ela será usada em `TRELLO_WEBHOOK_CALLBACK_URL`

## Configuração

Crie um arquivo `.env` na raiz do projeto com base no `.env.example`:

```bash
cp .env.example .env
```

Preencha as variáveis no `.env`:

| Variável | Descrição |
| --- | --- |
| `PORT` | Porta do servidor (padrão: `3080`) |
| `TRELLO_KEY` | API Key do Trello — obtenha em [trello.com/app-key](https://trello.com/app-key) |
| `TRELLO_TOKEN` | Token do Trello — gerado na mesma página |
| `TRELLO_OAUTH_SECRET` | OAuth Secret da aplicação — campo "Secret" em [trello.com/app-key](https://trello.com/app-key) |
| `TRELLO_BOARD_ID` | ID do board monitorado |
| `TRELLO_TARGET_LIST_ID` | (Opcional) ID fixo de uma única lista de triagem. Deixe vazio para descoberta automática pelos prefixos |
| `TRELLO_TARGET_LIST_PREFIXES` | Prefixos das listas de triagem separados por vírgula. Padrão: `Pendentes Analise - Chamados,Lotes` |
| `TRELLO_COUNTED_LIST_PREFIXES` | Prefixos das listas que terão contador no nome. Padrão: `Pendentes Analise - Chamados,Lotes,Em tratativa com Devs,Pendente publicar,Pendentes Resposta Tia Tati/Tia Regi` |
| `TRELLO_WEBHOOK_CALLBACK_URL` | URL pública do webhook com `/trello/webhook` no final (ex: URL do ngrok) |
| `TRELLO_SKIP_SIGNATURE` | `true` para desabilitar validação HMAC em desenvolvimento |
| `REPO_LABEL_MAP` | JSON mapeando labels do card para caminhos de repositórios locais |
| `DEFAULT_REPO_PATH` | Repositório padrão quando o card não tem label `repo:*` |
| `CLAUDE_BIN` | Caminho ou nome do binário do Claude CLI (padrão: `claude`) |
| `CLAUDE_MODEL` | Modelo do Claude a usar (ex: `sonnet`, `opus`, `claude-sonnet-4-6`) |
| `CLAUDE_MAX_TURNS` | Número máximo de turnos do Claude (padrão: `6`) |
| `OPENAI_API_KEY` | Chave da OpenAI para fallback automático quando o Claude atingir o limite |
| `OPENAI_MODEL` | Modelo da OpenAI usado no fallback. Exemplo: `gpt-5.1` |
| `OPENAI_API_BASE_URL` | Base URL da API da OpenAI. Padrão: `https://api.openai.com/v1` |
| `OPENAI_ORGANIZATION` | Opcional: organização usada na OpenAI |
| `OPENAI_PROJECT` | Opcional: projeto usado na OpenAI |

### Obtendo credenciais do Trello

**API Key e Secret (`TRELLO_KEY` e `TRELLO_OAUTH_SECRET`)**

1. Acesse [trello.com/app-key](https://trello.com/app-key)
2. Copie a **API Key** → `TRELLO_KEY`
3. Copie o campo **Secret** → `TRELLO_OAUTH_SECRET`

**Token (`TRELLO_TOKEN`)**

Acesse a URL abaixo substituindo `SUA_API_KEY` pela sua chave, autorize o acesso e copie o token gerado:

```text
https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=SUA_API_KEY&name=Bot%20de%20Triagem%20Tecnica
```

**ID do board (`TRELLO_BOARD_ID`)**

Com a Key e o Token em mãos, liste seus boards para encontrar o ID:

```bash
curl "https://api.trello.com/1/members/me/boards?fields=name,url&key=SUA_KEY&token=SEU_TOKEN"
```

O ID é o campo `"id"` do board desejado no JSON retornado.

### Mapeamento de repositórios por label

Adicione labels no formato `repo:nome-do-repo` nos cards do Trello e configure o mapeamento:

```env
REPO_LABEL_MAP={"repo:meu-api":"/home/usuario/projetos/meu-api","repo:meu-front":"/home/usuario/projetos/meu-front"}
```

Se o card não tiver label `repo:*`, o `DEFAULT_REPO_PATH` é usado como fallback.

### Listas monitoradas por padrão

**Triagem automática**

- `Pendentes Analise - Chamados`
- `Lotes`

**Contador no nome da lista**

- `Pendentes Analise - Chamados`
- `Lotes`
- `Em tratativa com Devs`
- `Pendente publicar`
- `Pendentes Resposta Tia Tati/Tia Regi`

O bot ignora o sufixo numérico atual ao localizar as listas. Assim, nomes como `Lotes (01)` e `Lotes (12)` continuam sendo reconhecidos como a mesma lista.

### Fallback para OpenAI

Se o Claude CLI retornar uma mensagem como `You've hit your limit`, o bot pode enviar a mesma triagem para a OpenAI automaticamente. Para isso, basta configurar `OPENAI_API_KEY` no `.env`.

Exemplo:

```env
OPENAI_API_KEY=<SECRET>
OPENAI_MODEL=gpt-5.1
```

Se `OPENAI_API_KEY` não estiver definida, o comportamento continua igual ao de hoje: a triagem falha quando o Claude entra em limite.

## Instalação e execução

```bash
# Instalar dependências
npm install

# Desenvolvimento com ngrok (sobe o servidor e o túnel simultaneamente)
npm run start:project

# Desenvolvimento apenas (sem ngrok)
npm run start:dev

# Produção
npm run build
npm run start:prod
```

## Registrando o webhook no Trello

Com o servidor rodando e o ngrok ativo, registre o webhook via API do Trello:

```bash
curl -X POST "https://api.trello.com/1/webhooks" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "SUA_TRELLO_KEY",
    "token": "SEU_TRELLO_TOKEN",
    "callbackURL": "https://sua-url.ngrok-free.app/trello/webhook",
    "idModel": "ID_DO_SEU_BOARD",
    "description": "Bot de triagem"
  }'
```

## Endpoints

| Método | Rota | Descrição |
| --- | --- | --- |
| `HEAD` | `/trello/webhook` | Validação do webhook pelo Trello (responde 200) |
| `POST` | `/trello/webhook` | Recebe eventos do Trello |
| `GET` | `/health` | Verifica se o bot está operacional |

### Health check

```http
GET http://localhost:3080/health
```

Exemplo de resposta:

```json
{
  "status": "ok",
  "timestamp": "2026-03-16T12:00:00.000Z",
  "checks": {
    "trello": { "ok": true, "message": "autenticado como @seu-usuario" },
    "claude": { "ok": true, "message": "claude 1.x.x" }
  }
}
```
