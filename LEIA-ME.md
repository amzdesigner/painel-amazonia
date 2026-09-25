# Painel Amazônia Gráfica — banco de dados

Arquivos do projeto:

- `index.html` — o painel
- `vercel.json` — configuração da Vercel
- `package.json` — diz à Vercel qual biblioteca instalar para falar com o banco
- `api/historico.js` — função que grava e lê o histórico de O.S. e recibos no banco

As tabelas do banco são criadas sozinhas na primeira vez que o painel se conectar.

Variáveis de ambiente necessárias na Vercel:

- `DATABASE_URL` — criada automaticamente ao conectar o banco Neon
- `PAINEL_SENHA` — a senha da equipe (você escolhe)
