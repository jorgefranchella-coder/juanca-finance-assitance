# Juanca — patrimonio familiar

Juanca es una aplicación patrimonial familiar en transición gradual hacia servicios autónomos de Hermes. Este repositorio reúne los microservicios y contratos actuales, la interfaz web y el código de integración previo para que la propuesta y su implementación estén disponibles en un solo lugar.

La especificación funcional y técnica está en [ESPECIFICACIONES_JUANCA_MICROSERVICIOS.md](docs/ESPECIFICACIONES_JUANCA_MICROSERVICIOS.md). El estado implementado, las decisiones y los pasos operativos están en [IMPLEMENTACION_F3_SOMBRA.md](docs/IMPLEMENTACION_F3_SOMBRA.md).

## Código

- `services/`, `packages/` e `infra/`: servicios de aplicación, ingesta y mercado, contratos y migraciones PostgreSQL.
- `workspace/apps/web`: interfaz web/PWA existente y su API de integración.
- `workspace/integration`: puente de compatibilidad con Hermes y utilidades del entorno anterior. Hermes no es requerido por los recorridos patrimoniales objetivo.
- `workspace/docs`: documentos de contexto de la aplicación existente y de la migración.

Los reportes patrimoniales, credenciales, tokens, respaldos y estado operativo son datos privados y no forman parte del repositorio.

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
```

Las pruebas PostgreSQL requieren la instancia privada preparada con `infra/postgres/local.sh bootstrap` y `start`; crean y eliminan una base sintética. Los servicios systemd de ejemplo son específicos del entorno local de Jorge. Datos, respaldos y tokens viven fuera del código en un directorio privado.

Contratos: [OpenAPI](packages/contracts/openapi.json) y [JSON Schema](packages/contracts/portfolio-v1.schema.json). No se han desplegado aún los servicios de ingesta y mercado.
