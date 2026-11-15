# Issues 25 y 26: helpers locales y concurrencia

## Copia verificada e identidad de sesión

`tools/session_backup.py` recibe el origen y el destino por argumentos, rechaza destinos dentro del árbol de la base y valida la copia creada. `tools/check_session_identity.py` compara la identidad del archivo abierto por un proceso con la ruta visible de la base para detectar reemplazos o descriptores desvinculados.

`tools/compare_sqlite_history.py DB_A DB_B` compara esquema y contenido de tablas ordinarias en modo de solo lectura; informa coincidencia, divergencia o una condición que impide comparar.

## Conflictos de instancia

El control de concurrencia distingue una instancia cuya identidad fue verificada de una mera colisión de recursos. Fallos al adquirir el bloqueo o registrar la instancia se propagan como fallos de inicio; errores distintos de contención no se interpretan como una instancia activa.

## Verificación

Las pruebas unitarias de las herramientas de sesión y del lector documental se ejecutan en una copia aislada. Las pruebas que dependen de un runtime externo requieren que su ubicación se configure en el entorno de pruebas. La verificación local no despliega cambios ni modifica servicios.
