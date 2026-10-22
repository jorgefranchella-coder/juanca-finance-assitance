# Runbook de migración y corte a PostgreSQL

Estado actualizado: 22/10/2026. D1/R2 sigue siendo la única autoridad de escritura y lectura de la web vigente. PostgreSQL y los servicios de ingesta/mercado siguen en sombra. Este runbook registra el preflight y define los gates para cambiar esa autoridad sin perder movimientos ni evidencia.

## Resultado del preflight

- Se creó el backup de autoridad `juanca-authority-20261022T122411Z-1643c27233`: 323 archivos, siete tablas SQLite y restauración aislada verificada. La captura anterior también se verificó manualmente. Los archivos están bajo `~/.local/share/juanca/backups/authority/`, fuera del repositorio.
- Se creó un backup verificado de PostgreSQL con application, ingestion y market; el paquete de corte está bajo `~/.local/share/juanca/backups/cutover-20261022/postgres/`.
- El envelope D1 usado para comparar tiene SHA-256 `c9159271ee81a2a83d66bbe9e75c64e4477e2c2935bec0cd7fe9598043ac8a9d` y está en `~/.local/share/juanca/backups/cutover-20261022/d1-envelope.json`.
- La comparación de cartera invertida está en `~/.local/share/juanca/backups/cutover-20261022/parity-invested-only.json`: 198 posiciones invertidas frente a 198, cantidades y valores coincidentes, total invertido coincidente de 1,034,813,755 centavos y cero diferencias. El efectivo se excluye expresamente del alcance patrimonial según la instrucción del usuario. No se debe interpretar esa exclusión como saldo cero o conciliación de caja.
- El envelope conserva avisos de precio/base ausente y una identidad de previsión sin resolver. No hay diferencias en holdings invertidos; los avisos afectan la calidad de valoración/proyección y deben mostrarse, no rellenarse por inferencia.
- El inventario de transferencia legacy contiene 21 objetos (1,626,855 bytes) y dos referencias de chat virtuales omitidas. Referencias D1/R2, hashes y tipos concuerdan; un objeto de tamaño cero tiene copia recuperable verificada en el object store sombra. El dry-run no escribe. Los originales D1/R2 se conservan.
- La prueba inicial del servicio de backup se canceló porque `Requires=patrimonio-juanca-worker.service` entraba en conflicto con la captura, que para la consistencia detiene el Worker. Se eliminó `Requires`, se mantuvo `After` y el servicio systemd completó una captura/restauración verificada. Web y Worker quedaron activos.
- La readiness de PostgreSQL todavía falla solo en `coordinated_writer_cutover_not_completed`; la identidad no resuelta de previsión no es apta para comandos, pero queda visible como dato incompleto.

## Secuencia segura

1. **Preparar y congelar el origen.** Confirmar que no haya importación en curso; hacer backup verificable de D1/R2 y PostgreSQL. Anotar hora, hashes y estado de servicios. Los backups deben completar restauración aislada. Mantener originales R2 hasta finalizar el periodo de reversión.
2. **Sincronizar cambios posteriores al snapshot.** Exportar D1/R2 en una ventana coordinada y repetir la importación idempotente. Transferir evidencia R2 con `npm run migration:transfer-legacy-r2 -- --apply`; comparar conteos, bytes y SHA-256. Mantener D1/R2 intacto. Los alias de cuenta y la atribución de movimientos deben tener soporte confirmado; no inferir una cuenta solo por titular o instrumento.
3. **Validar lectura completa.** Recalcular la cartera desde PostgreSQL y compararla con la autoridad legacy con el mismo corte temporal y las mismas reglas de efectivo. Revisar cantidad, valores, movimientos, lotes de adquisición, renta fija, vencimientos, evidencia y estados de revisión. Cada diferencia debe tener resolución documentada o ser un aviso aceptado explícitamente; no aceptar el corte solo porque el total agregado coincida.
4. **Migrar los caminos de escritura.** La UI, importadores y chat deben escribir en PostgreSQL mediante APIs idempotentes. La API debe soportar crear/revisar/aplicar/rechazar propuestas, auditoría append-only, selección explícita de cuenta de custodia, actualización/publicación de portfolio después de aplicar un evento y errores de concurrencia/idempotencia. Las proyecciones deben leer la versión publicada. Durante el corte debe existir un solo escritor: no dual-write a D1 y PostgreSQL.
5. **Ensayar corte y reversión.** En una ventana operativa, detener nuevas escrituras, capturar un último delta, importar y validar; verificar backup restaurable y una reversión ensayada. Cambiar juntos el backend de lectura y el de escritura. Hacer smoke tests de dashboard, posiciones, renta fija, carga de archivos, captura de evidencia y flujo de propuesta. Si falla una prueba, pausar escrituras y volver a la autoridad anterior usando el delta conciliado; jamás volver a aceptar escrituras en D1 y PostgreSQL en paralelo.
6. **Reabrir y vigilar.** Reabrir escrituras solo después de las comprobaciones. Vigilar errores, duplicados, retraso de ingesta, freshness de cartera/mercado y backup/restore. Al terminar el periodo acordado, retirar la escritura legacy; conservar los originales de evidencia según la política de retención.

## Gates que siguen bloqueando el corte

El corte no está listo porque la aplicación PostgreSQL aún no ofrece una sustitución de extremo a extremo para las escrituras y lecturas financieras de la web actual. La API sombra ya tiene rutas idempotentes para listar, crear y rechazar propuestas, y una ruta de aprobación; esta última rechaza hogares con portfolio publicado (`PORTFOLIO_REBUILD_REQUIRED`) porque el comando ledger aún no reconstruye/publica una versión inmutable. La web vigente sigue usando D1/R2 y el chat de PostgreSQL sigue registrando el movimiento como evidencia manual. Falta integrar la selección de cuenta de custodia y conectar la UI con estas rutas. Un cambio de autoridad ahora dejaría vistas obsoletas o movimientos sin registrar.

Para levantar el gate: completar el rebuild transaccional de la vista inmutable después de aplicar un evento (incluidos fecha efectiva y eventos retroactivos); soportar compras de activos sin posición previa con evidencia; conectar la UI/chat con las APIs y hacer explícita la cuenta requerida; agregar pruebas de contrato para duplicados, concurrencia y cuenta; migrar/reconciliar el delta más reciente; restaurar ambos backups; ejecutar el corte con un solo escritor y validar la reversión antes de reabrir.

## Comandos de verificación

```bash
# Ver estado del servicio y backup de autoridad
systemctl --user status juanca-authority-backup.timer juanca-authority-backup.service --no-pager
systemctl --user start juanca-authority-backup.service

# Inventario R2: validación sin escrituras (sin --apply)
cd /home/jorge/juanca
npm run migration:transfer-legacy-r2

# Pruebas de código
npm test
npm run typecheck
```

El backup del origen se ejecuta desde el checkout legado y preserva el estado local Hermes; el backup PostgreSQL cubre bases y objetos sombra. Los resultados y exportaciones con datos personales permanecen fuera del repositorio.
