# Monitor ITBI

Monitora o andamento de um processo ITBI na **SMFA (Prefeitura de Belo Horizonte)** e envia o status via **WhatsApp** em horários fixos, com alerta imediato caso o status mude.

## Estrutura do repositório

```text
monitor-itbi/
├── index.js           # scraper, cliente WhatsApp e agendamento
├── package.json
├── patches/           # fix de compatibilidade do whatsapp-web.js com WSL2
├── .env               # configuração local (não versionado)
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
└── README.md
```

## Tecnologias

- Node.js 18
- whatsapp-web.js
- axios + cheerio
- node-cron
- Docker (opcional)

## Observações

- A sessão do WhatsApp é persistida em `.wwebjs_auth/` (incluída no `.gitignore`).
- O cron usa o fuso `America/Sao_Paulo`.
- Um alerta extra é enviado imediatamente se o status mudar entre verificações.
- Para rodar em background sem Docker, use PM2: `pm2 start index.js --name monitor-itbi`.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PROCESS_NUMBER` | `70-029.875/26-08` | Número do processo ou protocolo ITBI |
| `WHATSAPP_GROUP_ID` | — | ID do grupo no WhatsApp (ex: `120363...@g.us`) |
| `CRON_SCHEDULE` | `0 * * * *` | Cron de disparo (padrão: todo `:00` de hora em hora) |

## Requisitos

### Local (Ubuntu / WSL2)

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo apt-get install -y chromium-browser
```

### Docker

```bash
curl -fsSL https://get.docker.com | sh
```

## Configuração

```bash
cp .env.example .env
npm install
```

Para encontrar o `WHATSAPP_GROUP_ID` antes de iniciar:

```bash
npm run list-groups
```

## Como rodar localmente

```bash
npm start
```

Após escanear, encerre com `Ctrl+C`.

Para testar o scraper sem WhatsApp:

```bash
npm run test-scrape
```

## Como rodar com Docker

Executar o container para escanear o QR Code:

```bash
docker compose up
```

Após escanear, encerre com `Ctrl+C`.

Executar o container em background:

```bash
docker compose up -d
```

Para testar o scraper sem WhatsApp:

```bash
docker compose run --rm monitor-itbi node index.js --test-scrape
```

## Consultar os logs no container

```bash
docker compose logs -f
```

## Parar e remover o container

```bash
docker compose down
```

## Publicar no Docker Hub

```bash
docker build -t seu-usuario/monitor-itbi:latest .
docker push seu-usuario/monitor-itbi:latest
```
