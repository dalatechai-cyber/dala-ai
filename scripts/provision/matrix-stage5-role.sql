-- Matrix Eco Salon — Stage 5: the reception entitlement.
--
-- `withTenantRole` step 2 reads `tenant_roles` for the role and refuses with a 403
-- `role_not_entitled` when there is no row, when `state` is neither `active` nor `trial`,
-- or when `roles.status` for that role is not `available`. Matrix had no row, so every
-- reply would have been refused before the budget check was even reached.
--
-- Not one of the four founder-gated categories. It is an entitlement, not a ceiling: it
-- says the tenant may use the role, and `tenant_budgets` — separately, and the founder's —
-- says what that use may cost. A role with no budget still cannot spend a cent.
--
-- ## What stays null, and why
--
-- `price_mnt` is the commercial term, and nobody has stated one for Matrix. D-015 sells
-- Reception against a 400-conversation band at ₮80,000, but that is the PLAN's price, not
-- a term agreed with this salon, and nothing collects money in any case (there is no
-- revenue path). Tenant #0's row leaves it null for the same reason. Writing a number here
-- would be inventing a commercial fact, which is D-020's sin in a column nobody reads.
--
-- `granted_by` references `platform_admins(user_id)` and that table is empty on the
-- project, so there is no admin row to point at. Same gap as `disclosure_rules.approved_by`
-- in Stage 3b — worth closing before the next tenant, because "who granted this" currently
-- lives only in git history.
--
-- Idempotent, with the end state asserted rather than assumed.

begin;

insert into tenant_roles (tenant_id, role, state, price_mnt, config, granted_by)
select t.id, 'reception', 'active', null, '{}'::jsonb, null
from tenants t
where t.slug = 'matrix-eco-salon'
  and not exists (
    select 1 from tenant_roles r where r.tenant_id = t.id and r.role = 'reception');

do $$
declare
  v_state  text;
  v_status text;
begin
  select tr.state, r.status into v_state, v_status
    from tenant_roles tr
    join tenants t on t.id = tr.tenant_id
    join roles r on r.role = tr.role
   where t.slug = 'matrix-eco-salon' and tr.role = 'reception';

  if v_state is null then
    raise exception 'stage 5: no reception row for matrix-eco-salon';
  end if;
  -- Both halves of the entitlement check, asserted the way withTenantRole reads them.
  if v_state not in ('active', 'trial') then
    raise exception 'stage 5: reception state is %, which withTenantRole refuses', v_state;
  end if;
  if v_status <> 'available' then
    raise exception 'stage 5: the reception ROLE is %, so the platform gate outranks the grant', v_status;
  end if;
end $$;

commit;
