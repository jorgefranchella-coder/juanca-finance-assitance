# Juanca — aplicación autónoma en sombra

Aplicación independiente de Hermes en PostgreSQL. F3 tiene API patrimonial de lectura y chat guiado propio en sombra. F4 incorpora código inicial de mercado e ingesta documental; ambos están preparados en el repositorio, sin migración ni servicios activos. La fotografía financiera publicada de F3 concilia. Dos reportes B3 de Jorge del 09/10/2026 están archivados y estructurados como evidencia nueva en sombra, con cuentas internas por custodio e interpretaciones versionadas; aún no se publicaron en la cartera. La conciliación de movimientos, las cuentas de Julia y la posición de previsión siguen pendientes antes del cambio de fuente.

Documentación funcional, técnica, operación y resultados: [Implementación F3](docs/IMPLEMENTACION_F3_SOMBRA.md).

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
```

Las pruebas PostgreSQL requieren la instancia privada preparada con `infra/postgres/local.sh bootstrap` y `start`; crean y eliminan una base sintética. Los servicios systemd de ejemplo son específicos del entorno local de Jorge. Datos, respaldos y tokens viven fuera del código en un directorio privado.

Contratos: [OpenAPI](packages/contracts/openapi.json) y [JSON Schema](packages/contracts/portfolio-v1.schema.json). No se han desplegado aún los servicios de ingesta y mercado.
