const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

code = code.replace(/function deleteActiveDraftBatch\(\) \{[\s\S]*?\}\n/g, '');

fs.writeFileSync('app.js', code);
