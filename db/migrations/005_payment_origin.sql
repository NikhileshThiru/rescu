-- Who started a payment: null for the sim's own households, otherwise the app surface
-- ('shop', 'agent', 'mcp', 'counter'), so the oracle and the dashboards can tell people from the sim.
alter table payments add column if not exists origin text;
comment on column payments.origin is 'Null = a simulated household; shop / agent / mcp / counter = a person or an agent through the app.';
