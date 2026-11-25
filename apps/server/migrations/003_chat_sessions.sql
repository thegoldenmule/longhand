-- Feedback chat: chat sessions name the conversation they answered in. Derived
-- from the streams like the rest of agent_sessions (rebuild refills it). Chats
-- themselves are rows of `annotations` with collection `chats`.
ALTER TABLE agent_sessions ADD COLUMN chat_id text;
