const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

// 1. Fix the array of filters
code = code.replace(/  \["portfolioSearch", "portfolioStatusFilter", "portfolioBatchFilter", "portfolioPageSize"\]/g, '  ["portfolioSearch", "portfolioStatusFilter", "portfolioPageSize"]');

// 2. Remove the form and batch active listeners (from `el("portfolioActiveBatch")` to `deleteActiveDraftBatch);`)
code = code.replace(/  el\("portfolioActiveBatch"\)[\s\S]*?deleteActiveDraftBatch\);\n/, '');

// 3. Add the applyBulkStatusBtn logic instead of addSelectedToBatchBtn logic, just like I did previously
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

// 4. Remove addSelectedToBatchBtn and put bulk logic
code = code.replace(/  el\("addSelectedToBatchBtn"\)[\s\S]*?persistPortfolioChange\(`\$\{added\.toLocaleString\(\)\} cards added to \$\{batch\.name\}\.`\);\n  \}\);\n/, bulkLogic);

fs.writeFileSync('app.js', code);
