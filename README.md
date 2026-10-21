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

`test:backup` comprueba con bases SQLite sintéticas la verificación de integridad, la detección de cambios, la restauración aislada y la orquestación del runner local. El verificador rechaza rutas fuera del backup, enlaces simbólicos, archivos añadidos y manifests incompletos. `npm test` también verifica hashes, rutas seguras y el conjunto exacto de archivos del manifest PostgreSQL. No usa datos patrimoniales ni credenciales reales. Para restauraciones PostgreSQL existe `infra/backup/verify_restore.ts`, que valida la copia en una base aislada.

## Respaldo PostgreSQL sombra

El timer `juanca-shadow-backup.timer` ejecuta cada día, alrededor de las 03:30 (hora local), una copia PostgreSQL y un ensayo de restauración en una base temporal. Las copias se guardan fuera del repositorio con permisos privados y no se eliminan automáticamente. Este respaldo cubre PostgreSQL sombra y la evidencia registrada allí; no incluye la base D1 vigente, sus objetos R2 ni una copia fuera del equipo. Estado del timer: `systemctl --user status juanca-shadow-backup.timer`.

El timer `juanca-authority-backup.timer` ejecuta a diario, alrededor de las 04:15 (hora local), el respaldo completo de la autoridad D1. Detiene web y Worker durante la copia coherente de D1, R2 y el estado Hermes, los vuelve a iniciar y prueba la restauración en un directorio aislado. El bloque `ExecStopPost` del servicio los inicia también si el proceso de captura termina antes de completar su rutina de cierre. Un backup parcial queda sin manifest y el chequeo diario lo reporta como inválido. La primera ejecución real está programada para el 22/10/2026; las pruebas previas usan datos sintéticos. Si el equipo está apagado a esa hora, el timer no hace una ejecución de recuperación durante el día. Las copias son privadas y no se purgan automáticamente. Estado: `systemctl --user status juanca-authority-backup.timer`.

`juanca-backup-health.timer` valida cada día a las 05:45 que la copia más reciente de cada conjunto esté dentro de 32 horas, tenga constancia de restauración aislada exitosa y pase su verificador de manifest. También se puede ejecutar `npm run backup:health`; un resultado fallido queda visible en el estado del servicio y en el journal. Este chequeo no detiene los servicios.
