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
npm run test:foundation
npm run typecheck
```

`test:backup` comprueba con bases SQLite sintéticas la verificación de integridad, la detección de cambios, la restauración aislada y la orquestación del runner local. El verificador rechaza rutas fuera del backup, enlaces simbólicos, archivos añadidos y manifests incompletos. `npm test` también verifica hashes, rutas seguras y el conjunto exacto de archivos del manifest PostgreSQL. No usa datos patrimoniales ni credenciales reales. Para restauraciones PostgreSQL existe `infra/backup/verify_restore.ts`, que valida la copia en una base aislada.

`test:foundation` reconstruye el bundle Wrangler local y ejecuta nueve escenarios HTTP con una base D1 efímera y datos sintéticos: selección por fecha económica e importación fuera de orden, vencimiento de Jorge entre su referencia y la referencia posterior de Julia, exclusión de compra sin orden temporal el día del corte, FX ausente, concurrencia/idempotencia, origen de evidencia, borradores en español, importación B3 duplicada y cola de confirmaciones. El runner cierra su proceso local, elimina el estado temporal y restaura exactamente el `wrangler.json` generado por el build; no usa el D1 de producción.

## Respaldo PostgreSQL sombra

El timer `juanca-shadow-backup.timer` ejecuta cada día, alrededor de las 03:30 (hora local), una copia PostgreSQL y un ensayo de restauración en una base temporal. Las copias se guardan fuera del repositorio con permisos privados y no se eliminan automáticamente. Este respaldo cubre PostgreSQL sombra y la evidencia registrada allí; no incluye la base D1 vigente, sus objetos R2 ni una copia fuera del equipo. Estado del timer: `systemctl --user status juanca-shadow-backup.timer`.

El timer `juanca-authority-backup.timer` ejecuta a diario, alrededor de las 04:15 (hora local), el respaldo de la autoridad D1 y el estado local asociado. Detiene web y Worker durante la captura coherente, los vuelve a iniciar y prueba la restauración en un directorio aislado. El bloque `ExecStopPost` proporciona una segunda garantía de inicio ante fallo o terminación anormal. La primera copia real verificada se completó el 22/10/2026: 322 archivos, siete tablas SQLite y restauración aislada correcta. Un backup parcial queda sin manifest válido y el chequeo diario lo reporta como inválido. Si el equipo está apagado en esa ventana, el timer no recupera la ejecución durante el día. Las copias locales son privadas y no se purgan automáticamente. Estado: `systemctl --user status juanca-authority-backup.timer`.

`juanca-backup-health.timer` valida cada día a las 05:45 que la copia más reciente de cada conjunto esté dentro de 32 horas, tenga constancia de restauración aislada exitosa, pase su verificador de manifest y que los sistemas de archivos conserven al menos 5 GiB libres. También se puede ejecutar `npm run backup:health`; un resultado fallido queda visible en el estado del servicio y en el journal. Este chequeo no detiene los servicios.

### Comprobar y ensayar una recuperación

Consultar el resultado programado con `systemctl --user status juanca-backup-health.service` y `journalctl --user -u juanca-backup-health.service`. Para verificar y ensayar una copia de autoridad disponible:

```bash
cd /home/jorge/.hermes/profiles/juanca/workspace/patrimonio-familiar-source
BACKUP="$(find /home/jorge/.local/share/juanca/backups/authority -mindepth 1 -maxdepth 1 -type d -name 'juanca-authority-*' | sort | tail -n 1)"
test -n "$BACKUP"
python3 integration/backup_restore.py verify --backup "$BACKUP"
python3 integration/backup_restore.py restore --backup "$BACKUP" --destination "/tmp/juanca-restore-$(date -u +%Y%m%dT%H%M%SZ)"
```

La restauración crea un directorio nuevo y aislado, verifica SQLite y copia el estado Hermes, pero omite credenciales y no inicia servicios. Es un ensayo y una fuente para recuperación manual; no se debe cambiar la ruta de producción a ese directorio. No hay automatización para promover una restauración a producción. Cada copia sombra sí se restaura y compara durante su creación; el comando siguiente vuelve a comprobar hashes y restaura el backup histórico en una base PostgreSQL aislada:

```bash
cd /home/jorge/juanca
SHADOW_BACKUP="$(find /home/jorge/.local/share/juanca/backups/postgres -mindepth 1 -maxdepth 1 -type d -name 'postgres-verified-*' | sort | tail -n 1)"
test -n "$SHADOW_BACKUP"
/home/jorge/.local/bin/node --experimental-strip-types /home/jorge/juanca/infra/backup/verify_manifest.ts "$SHADOW_BACKUP"
npm run backup:restore-check -- "$SHADOW_BACKUP"
```

El comando crea una base `juanca_verify_<id>`, restaura aplicación, ingesta y mercado, compara el conjunto de tablas con el manifest y elimina esa base al salir. Nunca apunta a `juanca_shadow` ni promueve el backup a producción.

### Copia cifrada fuera del equipo

`workspace/integration/offsite_export.py` genera archivos `.tar.gz.gpg` de los backups de autoridad y PostgreSQL usando la llave pública dedicada, y deja los cifrados en `~/.local/share/juanca/backups/offsite-outbox` con permisos privados. No genera un tar sin cifrar en disco. `npm run backup:offsite:prepare` solo prepara los artefactos; no los transmite. `juanca-offsite-backup.timer` ejecuta el flujo diario después del chequeo de salud y copia los cifrados a `pcloud:Backups/Juanca`, verificando el hash remoto. El servicio requiere que el chequeo diario pase y usa `JUANCA_OFFSITE_KEY_RECOVERY_CONFIRMED=1`; la llave privada de recuperación está en una carpeta de Google Drive sin compartir y también permanece local, fuera del repositorio y de pCloud. No tiene frase de paso, así que el acceso a Google permite descifrar las copias de pCloud. No se configura una política de borrado de backups remotos. Para probar la subida manualmente, usar `--upload` con `JUANCA_OFFSITE_REMOTE` explícito y solo después de comprobar la copia de recuperación.
