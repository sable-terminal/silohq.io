DELETE FROM connector_auth_strategies
 WHERE strategy IN ('none','oauth2_password','ssh_key','placed','session','jwt_assertion','signed','ws_security','ntlm','negotiate','all_of');
