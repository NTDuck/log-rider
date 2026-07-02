const chHost = 'localhost';
const lastTimestamp = '2026-07-02';
const query = `
    SELECT l.*, t.Tags
    FROM logrider.logs l
    LEFT JOIN logrider.log_tags t ON l.Trace_ID = t.Trace_ID
    WHERE l.Timestamp > '${lastTimestamp}'
    ORDER BY l.Timestamp ASC
    LIMIT 1
    FORMAT JSON
`;
fetch(`http://${chHost}:8123/?user=default&password=password`, { method: 'POST', body: query })
    .then(res => res.json())
    .then(data => console.log(JSON.stringify(data.data[0], null, 2)));
