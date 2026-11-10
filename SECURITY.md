# Seguridad y privacidad

Esta copia se preparó por separado. No requiere la aplicación original ni un respaldo privado.

- Se excluyen `data/`, `uploads/`, bases, archivos de entorno, logs y formatos habituales de respaldo.
- El único conjunto inicial está definido en `scripts/seed-demo-data.js`: nombres DEMO, identificaciones ficticias y correos de ejemplo.
- Se omitieron herramientas de reseteo, limpieza, migración manual y el archivo antiguo `app_clean.js`.
- Los adjuntos admitidos son PDF de hasta 10 MB, con comprobación de cabecera. Esto no es un análisis antivirus del PDF.
- Se rechazan rutas absolutas, escapes fuera de la carpeta de adjuntos y enlaces simbólicos o junctions en esas rutas.
- Se escaparon interpolaciones de datos en plantillas HTML y se protegieron argumentos de manejadores de periodos y facturas.
- Se desactivó la reconciliación automática al iniciar y al consultar datos. La operación explícita de reconciliación de la API permanece disponible para el usuario local.
- Se restringen Host, Origin, solicitudes entre sitios y el tipo de contenido de operaciones de escritura.
- Las dependencias de interfaz tienen versiones fijadas y se sirven localmente. El lockfile registra integridad de paquetes.
- Hay pruebas de regresión, comprobación de archivos destinados a Git y auditoría en GitHub Actions.

La aplicación conserva manejadores de eventos inline, por lo que su política CSP permite `unsafe-inline`. No se declara preparada para producción ni libre de todas las vulnerabilidades. No contiene autenticación de usuarios y debe mantenerse ligada a la interfaz local.

No incluyas información privada en issues, capturas, ejemplos ni mensajes de error publicados. Si accidentalmente se publica un secreto, retirarlo del archivo no lo retira del historial: revócalo y revisa el historial antes de continuar.
