const fs = require('fs');
const glob = require('fs').readdirSync;
const path = require('path');

const mappings = {
  'Application_Name': 'application_name',
  'Log_Level': 'severity',
  'Trace_ID': 'trace_id',
  'Timestamp': 'event_timestamp',
  'Message': 'message',
  'Tags': 'tags'
};

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(function(file) {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(walk(file));
    } else { 
      if (file.endsWith('.js') || file.endsWith('.html') || file.endsWith('.ts') || file.endsWith('.go')) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = [...walk('./apps/web'), ...walk('./apps/telegram-bot'), ...walk('./apps/alert-worker')];

for (const f of files) {
  let content = fs.readFileSync(f, 'utf8');
  let changed = false;
  for (const [k, v] of Object.entries(mappings)) {
    const regex = new RegExp("\\b" + k + "\\b", "g");
    if (regex.test(content)) {
      content = content.replace(regex, v);
      changed = true;
    }
  }
  // also fix some specific cases where aliased log.log_level -> log.severity and log.application_name wasn't changed because it was already application_name but the fallback was Application_Name.
  
  if (changed) {
    fs.writeFileSync(f, content);
    console.log("Updated", f);
  }
}
