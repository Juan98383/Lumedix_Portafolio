# LuMedix Portafolio

Demostración local de gestión de inventario, compras, ventas, gastos y reportes, con Node.js, Express y SQLite. El repositorio contiene código y un generador de información ficticia. No incluye bases de datos, facturas ni información de clientes reales.

## Ejecutar

Instala Node.js 24 LTS y npm. Desde la carpeta del proyecto:

```sh
npm ci
npm start
```

Abre <http://127.0.0.1:3100>. Para otro puerto, configura `PORT` en el entorno antes de iniciar. Se admiten solicitudes dirigidas a `127.0.0.1` o `localhost` y el servidor escucha únicamente en la interfaz local.

En el primer inicio se crea `data/lumedix-demo.db` con información ficticia. El generador no reemplaza una base que ya contenga datos ni reinicia sus tablas por cambios de versión. Las operaciones realizadas se conservan localmente. No utilices datos reales en esta demostración.

Las dependencias de la interfaz se sirven localmente desde los paquetes instalados; no se descargan scripts desde CDN al abrir la aplicación. La instalación inicial requiere Internet, incluido el servidor oficial de SheetJS.

## Verificar

```sh
npm test
npm audit
npm run check:publish
```

La última comprobación necesita un repositorio Git con archivos añadidos. Examina los nombres de archivos del índice de Git y el contenido actual de esos archivos. Es una ayuda y no reemplaza la revisión humana de datos, imágenes, secretos o historial.

## Preparar la subida a GitHub

Trabaja únicamente con esta copia preparada. Antes del primer commit:

```sh
git init -b main
git add .
git status --short
npm run check:publish
git diff --cached --stat
git diff --cached
```

Comprueba que no aparezcan `data/`, `uploads/`, bases SQLite, facturas, respaldos, `.env` ni `node_modules/`. Si hiciste cambios después de añadir archivos, vuelve a ejecutar `git add .` y las comprobaciones.

Configura tu identidad Git si hace falta, crea el commit y enlaza un repositorio vacío creado en tu cuenta de GitHub:

```sh
git commit -m "Preparar demostración LuMedix para portafolio"
git remote add origin https://github.com/TU_USUARIO/TU_REPOSITORIO.git
git push -u origin main
```

Reemplaza los marcadores por tu usuario y repositorio. No incluyas tokens en la URL. No se proporciona una licencia de redistribución del código propio: el titular debe elegirla antes de conceder esos permisos. Las dependencias conservan sus propias licencias.

## Alcance

GitHub aloja el código. GitHub Pages no ejecuta este servidor Node.js ni SQLite. Esta versión es una demostración local sin autenticación multiusuario. Un despliegue público requiere un diseño de autenticación, autorización, HTTPS, almacenamiento, copias de seguridad y operación adicional.

Consulta `SECURITY.md` para los controles y límites de esta preparación.
