DROP VIEW `tenant_readiness`;--> statement-breakpoint
CREATE VIEW `tenant_readiness` AS 
  select
    tenant.id as tenant_id,
    case
      when subscription_entitlement.status not in ('active', 'trialing')
        or tenant.status in ('suspended', 'archived') then 'suspended'
      when tenant.status = 'active'
        and tenant.desired_state = 'running'
        and agent_instance.desired_mode = 'operate'
        and agent_instance.applied_mode = 'operate'
        and agent_instance.observed_state = 'healthy'
        and agent_instance.applied_config_version = tenant.config_version
        and model_connection.status = 'ready'
        and whatsapp_connection.status = 'online'
        and managed_chat_selection.status = 'selected'
        and (
          select count(*)
          from github_installation
          where github_installation.tenant_id = tenant.id
            and github_installation.status = 'installed'
            and github_installation.role in ('coder', 'reviewer', 'planner')
        ) = 3
        and exists (
          select 1 from tenant_managed_chat
          where tenant_managed_chat.tenant_id = tenant.id
        )
        and (
          select count(distinct github_repository.installation_role)
          from github_installation
          join github_repository
            on github_repository.tenant_id = github_installation.tenant_id
            and github_repository.installation_role = github_installation.role
            and github_repository.installation_id = github_installation.installation_id
          where github_installation.tenant_id = tenant.id
            and github_installation.status = 'installed'
            and github_installation.role in ('coder', 'reviewer', 'planner')
            and github_repository.selected = 1
            and github_repository.is_default = 1
        ) = 3
        and delivery_route.status = 'ready' then 'healthy'
      when tenant.status = 'active' then 'degraded'
      else 'onboarding'
    end as readiness
  from tenant
  join subscription_entitlement
    on subscription_entitlement.id = tenant.subscription_entitlement_id
  left join agent_instance on agent_instance.tenant_id = tenant.id
  left join model_connection on model_connection.tenant_id = tenant.id
  left join whatsapp_connection on whatsapp_connection.tenant_id = tenant.id
  left join managed_chat_selection on managed_chat_selection.tenant_id = tenant.id
  left join delivery_route on delivery_route.tenant_id = tenant.id
;