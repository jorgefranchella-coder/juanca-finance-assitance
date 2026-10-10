# Arquitetura do Patrimônio

## Princípios

1. Dados brutos são imutáveis e sempre rastreáveis ao arquivo e à linha de origem.
2. Fatos observados, premissas, projeções e recomendações são entidades diferentes.
3. Débito e crédito de custódia não são tratados como sinal de caixa.
4. Uma recomendação deve informar evidências, data-base, política e bloqueios de qualidade.
5. Nenhuma recomendação executa uma ordem de investimento.

## Módulos

- **ingestion**: adaptadores B3 XLSX, dados manuais e futuras APIs.
- **reconciliation**: classificação de eventos e fechamento de quantidades.
- **portfolio**: posições, contas, instrumentos, valuations e histórico.
- **projections**: cenários versionados e fluxos futuros.
- **recommendations**: regras determinísticas e explicações auditáveis.
- **api**: contratos HTTP tipados.
- **web**: experiência de gestão, revisão e simulação.

## Fluxo de confiança

`arquivo -> registro bruto -> evento normalizado -> conciliação -> posição -> projeção -> recomendação`

Cada etapa pode produzir uma pendência. Dados com pendências continuam visíveis, mas bloqueiam conclusões dependentes deles.
