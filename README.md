# Juanca

Aplicación privada para consultar y registrar el patrimonio familiar de Jorge y Julia. La web actual y D1 siguen siendo la autoridad financiera; la aplicación PostgreSQL y los servicios de ingesta y mercado funcionan en sombra mientras se verifica la migración.

La documentación vigente está consolidada en tres documentos:

- [Especificación funcional](docs/ESPECIFICACION_FUNCIONAL.md): reglas de negocio, fuentes, recorridos y condiciones de aceptación.
- [Especificación técnica](docs/ESPECIFICACION_TECNICA.md): componentes, datos, contratos, seguridad, operación y migración.
- [Especificación UX](docs/ESPECIFICACION_UX.md): navegación, matriz de renta fija, estados e interacciones.

El código de la web vigente está en `workspace/apps/web`; los servicios nuevos en `services`; los contratos en `packages/contracts`; y las migraciones y utilidades en `infra`. Los datos, documentos originales, claves y respaldos son privados y no forman parte del repositorio.

## Validación

Con Node.js 22.13 o superior y Python 3:

```bash
npm ci
npm test
npm run test:backup
npm run typecheck
```

`test:backup` comprueba con bases SQLite sintéticas la verificación de integridad, la detección de cambios y la restauración aislada. `npm test` también verifica hashes, rutas seguras y el conjunto exacto de archivos del manifest PostgreSQL. No usa datos patrimoniales ni credenciales reales. Para restauraciones PostgreSQL existe `infra/backup/verify_restore.ts`, que valida la copia en una base aislada.

## Respaldo PostgreSQL sombra

El timer `juanca-shadow-backup.timer` ejecuta cada día, alrededor de las 03:30 (hora local), una copia PostgreSQL y un ensayo de restauración en una base temporal. Las copias se guardan fuera del repositorio con permisos privados y no se eliminan automáticamente. Este respaldo cubre PostgreSQL sombra y la evidencia registrada allí; no incluye la base D1 vigente, sus objetos R2 ni una copia fuera del equipo. Estado del timer: `systemctl --user status juanca-shadow-backup.timer`.
