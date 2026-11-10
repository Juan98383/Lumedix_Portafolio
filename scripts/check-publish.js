const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let files;
try {
    files = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
    console.error('Inicializa Git y añade los archivos antes de ejecutar esta comprobación.');
    process.exit(1);
}
const forbidden = /(^|\/)(data|uploads|node_modules|backups?|respaldo[s]?)(\/|$)|(^|\/)\.env($|\.)|\.(db($|-)|sqlite\d*($|-)|db3$|pdf$|bak$|backup$|zip$|7z$|log$|pem$|key$)/i;
const problems = [];
for (const file of files) {
    if (forbidden.test(file) && !file.endsWith('/.env.example') && file !== '.env.example') problems.push('Archivo privado o generado: ' + file);
    if (/\.(js|json|html|md|ya?ml|txt)$/.test(file)) {
        const content = fs.readFileSync(path.join(root, file), 'utf8');
        if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|sk_live_[A-Za-z0-9]{20,}/.test(content)) problems.push('Posible secreto: ' + file);
        if (/[A-Z]:[\\/](?:Users|OneDrive)[\\/]/i.test(content)) problems.push('Ruta personal absoluta: ' + file);
    }
}
if (!files.length) problems.push('No hay archivos preparados para publicar.');
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Comprobados ${files.length} archivos de Git: sin bases, adjuntos, respaldos ni secretos de los patrones revisados.`);
