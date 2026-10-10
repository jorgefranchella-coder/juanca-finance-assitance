# Patrimônio

Aplicação privada para gestão patrimonial familiar, reconciliação de arquivos da B3, projeções e recomendações explicáveis.

## Estado do MVP

- importador de posições B3;
- importador de movimentações B3;
- normalização de eventos com pernas de posição e caixa;
- reconciliação de quantidades;
- motor inicial de projeções nominais e reais;
- regras iniciais de qualidade, concentração e vencimentos;
- API FastAPI;
- interface web responsiva;
- esquema PostgreSQL auditável.

## Execução local

1. Suba `db`, `api` e `web` com Docker Compose.
2. A interface fica disponível em `http://localhost:3000`.
3. A documentação da API fica disponível em `http://localhost:8000/docs`.

Os arquivos patrimoniais são privados e não devem ser versionados. As pastas `data/raw` e `data/private` são ignoradas pelo Git.
