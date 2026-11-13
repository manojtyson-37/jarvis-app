-- Which device a chat message came from: 'web', 'pet', 'telegram', or 'system' (Maya's own background reports).
-- Additive only: one nullable column, no rows changed or deleted. Rows from before this stay NULL (unknown).
ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS channel TEXT;
