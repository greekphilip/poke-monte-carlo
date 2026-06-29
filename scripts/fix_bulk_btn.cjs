const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

code = code.replace(/    state\.portfolioSelectedIds\.clear\(\);\n    persistPortfolioChange\(`\$\{added\.toLocaleString\(\)\} cards added to \$\{batch\.name\}\.`\);\n  \}\);\n/g, '');

const bulkLogic = `  el("applyBulkStatusBtn").addEventListener("click", () => {
    const status = el("bulkStatusSelect").value;
    if (!status) return;
    let changed = 0;
    state.portfolioSelectedIds.forEach((id) => {
      let record = state.portfolio.records[id];
      if (!record) {
        record = {
          estimatedGrade: null,
          estimateConfidence: 70,
          actualGrade: null,
          actualSalePrice: null,
          status: "inventory",
          notes: ""
        };
        state.portfolio.records[id] = record;
      }
      if (record.status !== status) {
        record.status = status;
        changed++;
      }
    });
    if (changed) {
      persistPortfolioChange(\`Updated \${changed} card\${changed === 1 ? "" : "s"}.\`);
    } else {
      toast("No changes made.");
    }
  });\n`;

code = code.replace(/  el\("portfolioPrevBtn"\)\.addEventListener\("click", \(\) => \{/g, bulkLogic + '  el("portfolioPrevBtn").addEventListener("click", () => {');

fs.writeFileSync('app.js', code);
