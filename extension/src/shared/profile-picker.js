/** One compact named-profile selector, shared by the popup, Settings and on-X editor. */
import { dialogIcon } from '../content/dialog-icons.js';
import { DEFAULT_PROFILE_ID } from './profiles.js';

let nextPickerId = 0;

export function createProfilePicker({ client, manage = false, label: labelText = 'Profile' }) {
    const pickerId = ++nextPickerId;
    const element = document.createElement('section');
    element.className = 'xp-profile-picker';
    const row = document.createElement('div');
    row.className = 'xp-profile-row';
    const label = document.createElement('label');
    label.className = 'xp-profile-label';
    label.id = `xp-profile-label-${pickerId}`;
    label.textContent = labelText;
    const select = document.createElement('button');
    select.type = 'button';
    select.id = `xp-profile-select-${pickerId}`;
    select.className = 'xp-profile-select';
    select.setAttribute('role', 'combobox');
    select.setAttribute('aria-haspopup', 'listbox');
    select.setAttribute('aria-expanded', 'false');
    select.setAttribute('aria-controls', `xp-profile-list-${pickerId}`);
    const selectedName = document.createElement('span');
    selectedName.id = `xp-profile-value-${pickerId}`;
    selectedName.className = 'xp-profile-value';
    select.setAttribute('aria-labelledby', `${label.id} ${selectedName.id}`);
    const chevron = dialogIcon('chevronRight', 14);
    chevron.classList.add('xp-profile-chevron');
    select.append(selectedName, chevron);
    label.htmlFor = select.id;
    row.append(label, select);
    element.append(row);

    const status = document.createElement('p');
    status.className = 'xp-profile-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    let busy = false;
    let disposed = false;
    let mode = null;
    let editProfile = null;
    let catalogSignature = '';
    let form = null;
    let nameInput = null;
    let newButton = null;
    let renameButton = null;
    let deleteButton = null;
    let open = false;
    let activeIndex = -1;
    let typeahead = '';
    let typeaheadTime = 0;
    let statusTimer = null;
    const menu = document.createElement('div');
    menu.id = `xp-profile-list-${pickerId}`;
    menu.className = 'xp-profile-listbox';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-labelledby', label.id);
    menu.hidden = true;

    function closeMenu() {
        open = false;
        menu.hidden = true;
        menu.remove();
        select.setAttribute('aria-expanded', 'false');
        select.removeAttribute('aria-activedescendant');
        typeahead = '';
    }

    function positionMenu() {
        if (!open) return;
        const viewport = window.visualViewport;
        const leftEdge = (viewport?.offsetLeft || 0) + 8;
        const topEdge = (viewport?.offsetTop || 0) + 8;
        const rightEdge = leftEdge + (viewport?.width || window.innerWidth) - 16;
        const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - 16;
        const anchor = select.getBoundingClientRect();
        if (anchor.bottom < topEdge || anchor.top > bottomEdge || anchor.right < leftEdge || anchor.left > rightEdge) {
            closeMenu();
            return;
        }
        const width = Math.min(Math.max(anchor.width, 190), rightEdge - leftEdge);
        const below = Math.max(0, bottomEdge - anchor.bottom - 5);
        const above = Math.max(0, anchor.top - topEdge - 5);
        const height = Math.min(280, menu.scrollHeight || client.state.profiles.length * 36 + 8);
        const upwards = below < height && above > below;
        const available = upwards ? above : below;
        const visibleHeight = Math.min(height, available);
        menu.style.inlineSize = `${width}px`;
        menu.style.maxBlockSize = `${visibleHeight}px`;
        menu.style.left = `${Math.min(Math.max(anchor.left, leftEdge), rightEdge - width)}px`;
        menu.style.top = `${upwards ? anchor.top - 5 - visibleHeight : anchor.bottom + 5}px`;
    }

    function activate(index, scroll = true) {
        if (!open) return;
        const options = [...menu.children];
        if (!options.length) return;
        activeIndex = Math.max(0, Math.min(options.length - 1, index));
        options.forEach((option, i) => option.classList.toggle('is-active', i === activeIndex));
        const active = options[activeIndex];
        select.setAttribute('aria-activedescendant', active.id);
        if (scroll) {
            const item = active.getBoundingClientRect();
            const bounds = menu.getBoundingClientRect();
            if (item.top < bounds.top + 4) menu.scrollTop -= bounds.top + 4 - item.top;
            else if (item.bottom > bounds.bottom - 4) menu.scrollTop += item.bottom - bounds.bottom + 4;
        }
    }

    function openMenu(index) {
        if (select.disabled || disposed) return;
        open = true;
        menu.hidden = false;
        document.body.append(menu);
        select.setAttribute('aria-expanded', 'true');
        positionMenu();
        activate(index ?? Math.max(0, client.state.profiles.findIndex(profile => profile.id === client.state.profileId)));
    }

    async function choose(index) {
        const profile = client.state.profiles[index];
        if (!profile) return;
        closeMenu();
        closeForm();
        select.focus({ preventScroll: true });
        await run(() => client.select(profile.id), 'Profile selected');
        if (!disposed && select.isConnected && (document.activeElement === document.body || document.activeElement === select)) {
            select.focus({ preventScroll: true });
        }
    }

    function handleKeydown(event) {
        if (select.disabled) return;
        const key = event.key;
        if (key === 'Tab') { closeMenu(); return; }
        if (key === 'Escape') {
            if (!open) return;
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            return;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            if (event.altKey && key === 'ArrowUp') closeMenu();
            else if (!open) openMenu();
            else activate(activeIndex + (key === 'ArrowDown' ? 1 : -1));
            return;
        }
        if (key === 'Home' || key === 'End') {
            event.preventDefault();
            event.stopPropagation();
            const index = key === 'Home' ? 0 : client.state.profiles.length - 1;
            if (!open) openMenu(index); else activate(index);
            return;
        }
        if (key === 'Enter' || (key === ' ' && (!typeahead || Date.now() - typeaheadTime > 800))) {
            event.preventDefault();
            event.stopPropagation();
            if (open) void choose(activeIndex); else openMenu();
            return;
        }
        if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            if (!open) openMenu();
            const now = Date.now();
            typeahead = now - typeaheadTime > 800 ? key : typeahead + key;
            typeaheadTime = now;
            const repeated = [...typeahead].every(character => character === typeahead[0]);
            const query = (repeated ? key : typeahead).toLocaleLowerCase();
            const profiles = client.state.profiles;
            for (let step = repeated ? 1 : 0; step < profiles.length + (repeated ? 1 : 0); step++) {
                const index = (activeIndex + step) % profiles.length;
                if (profiles[index].name.toLocaleLowerCase().startsWith(query)) { activate(index); break; }
            }
        }
    }

    const clickAway = event => { if (!element.contains(event.target) && !menu.contains(event.target)) closeMenu(); };
    const focusAway = event => { if (event.target !== select) closeMenu(); };
    select.addEventListener('click', () => { if (open) closeMenu(); else openMenu(); });
    select.addEventListener('keydown', handleKeydown);
    document.addEventListener('pointerdown', clickAway, true);
    document.addEventListener('focusin', focusAway, true);
    document.addEventListener('scroll', positionMenu, true);
    window.addEventListener('resize', positionMenu);
    window.visualViewport?.addEventListener('resize', positionMenu);
    window.visualViewport?.addEventListener('scroll', positionMenu);

    function button(text, className = '') {
        const control = document.createElement('button');
        control.type = 'button';
        control.className = `xp-profile-button ${className}`.trim();
        control.textContent = text;
        return control;
    }

    function showStatus(message = '', error = false) {
        if (disposed) return;
        clearTimeout(statusTimer);
        status.textContent = message;
        status.hidden = !message;
        status.classList.toggle('xp-profile-error', error);
        if (message && !error) statusTimer = setTimeout(() => showStatus(), 2400);
    }

    function closeForm(restoreFocus = false) {
        mode = null;
        editProfile = null;
        form?.remove();
        form = null;
        nameInput = null;
        if (restoreFocus) select.focus();
    }

    function render() {
        if (disposed) return;
        const state = client.state;
        const signature = JSON.stringify(state.profiles?.map(profile => [profile.id, profile.name]) || []);
        const activeProfileId = menu.children[activeIndex]?.dataset.value;
        if (signature !== catalogSignature) {
            catalogSignature = signature;
            const options = (state.profiles || []).map((profile, index) => {
                const option = document.createElement('div');
                option.id = `xp-profile-option-${pickerId}-${index}`;
                option.className = 'xp-profile-option';
                option.setAttribute('role', 'option');
                option.dataset.value = profile.id;
                const name = document.createElement('span');
                name.textContent = profile.name;
                option.append(name, dialogIcon('check', 14));
                option.addEventListener('pointerdown', event => event.preventDefault());
                option.addEventListener('pointermove', () => { if (open) activate(index, false); });
                option.addEventListener('click', event => { event.stopPropagation(); void choose(index); });
                return option;
            });
            menu.replaceChildren(...options);
            activeIndex = state.profiles.findIndex(profile => profile.id === activeProfileId);
            if (activeIndex < 0) activeIndex = Math.max(0, state.profiles.findIndex(profile => profile.id === state.profileId));
        }
        select.dataset.value = state.profileId || '';
        selectedName.textContent = state.profiles?.find(profile => profile.id === state.profileId)?.name || 'Loading…';
        for (const option of menu.children) option.setAttribute('aria-selected', String(option.dataset.value === state.profileId));
        const disabled = busy || state.pending || !state.ready;
        select.disabled = disabled;
        if (disabled) closeMenu();
        else if (open) { positionMenu(); activate(Math.min(activeIndex, menu.children.length - 1)); }
        element.setAttribute('aria-busy', disabled ? 'true' : 'false');
        for (const control of [newButton, renameButton, deleteButton]) {
            if (control) control.disabled = disabled || (control === deleteButton && state.profileId === DEFAULT_PROFILE_ID);
        }
        if (mode && !busy && editProfile !== state.profileId) closeForm();
        for (const control of form?.querySelectorAll('input, button') || []) control.disabled = disabled;
    }

    async function run(operation, success, { close = true } = {}) {
        if (busy || disposed) return false;
        busy = true;
        showStatus();
        render();
        try {
            const response = await operation();
            if (disposed) return false;
            if (!response?.success) throw new Error(response?.error || 'Could not save this profile.');
            if (close) closeForm();
            showStatus(success);
            return true;
        } catch (error) {
            showStatus(error?.message || 'Could not save this profile. Please try again.', true);
            return false;
        } finally {
            busy = false;
            render();
        }
    }

    function openNameForm(nextMode) {
        if (busy || !client.state.ready) return;
        closeMenu();
        closeForm();
        mode = nextMode;
        editProfile = client.state.profileId;
        form = document.createElement('form');
        form.className = 'xp-profile-form';
        const field = document.createElement('label');
        field.className = 'xp-profile-name-field';
        field.textContent = nextMode === 'create' ? 'New profile name' : 'Profile name';
        nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.maxLength = 40;
        nameInput.required = true;
        nameInput.autocomplete = 'off';
        nameInput.value = nextMode === 'rename'
            ? client.state.profiles.find(profile => profile.id === editProfile)?.name || '' : '';
        field.append(nameInput);
        const actions = document.createElement('div');
        actions.className = 'xp-profile-form-actions';
        const save = button(nextMode === 'create' ? 'Create' : 'Save', 'xp-profile-primary');
        save.type = 'submit';
        const cancel = button('Cancel');
        cancel.addEventListener('click', () => { closeForm(true); showStatus(); });
        actions.append(save, cancel);
        form.append(field, actions);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const name = nameInput.value.trim();
            if (!name) { nameInput.focus(); return; }
            const profileId = editProfile;
            const creating = mode === 'create';
            if (await run(() => creating ? client.create(name) : client.rename(profileId, name), creating ? 'Profile created' : 'Profile renamed')) {
                select.focus();
            }
        });
        form.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !busy) {
                event.preventDefault();
                event.stopPropagation();
                closeForm(true);
            }
        });
        element.insertBefore(form, status);
        showStatus();
        nameInput.focus();
        nameInput.select();
    }

    function openDeleteForm() {
        if (busy || !client.state.ready || client.state.profileId === DEFAULT_PROFILE_ID) return;
        closeMenu();
        closeForm();
        mode = 'delete';
        editProfile = client.state.profileId;
        form = document.createElement('div');
        form.className = 'xp-profile-form xp-profile-confirm';
        const description = document.createElement('p');
        const name = client.state.profiles.find(profile => profile.id === editProfile)?.name || 'this profile';
        const defaultName = client.state.profiles.find(profile => profile.id === DEFAULT_PROFILE_ID)?.name || 'Default';
        description.textContent = `Delete “${name}” and its filters? Accounts using it will return to “${defaultName}”.`;
        const actions = document.createElement('div');
        actions.className = 'xp-profile-form-actions';
        const remove = button('Delete profile', 'xp-profile-danger');
        const cancel = button('Cancel');
        remove.addEventListener('click', async () => {
            const profileId = editProfile;
            if (await run(() => client.remove(profileId), 'Profile deleted')) select.focus();
        });
        cancel.addEventListener('click', () => { closeForm(true); showStatus(); });
        actions.append(remove, cancel);
        form.append(description, actions);
        element.insertBefore(form, status);
        showStatus();
        cancel.focus();
    }

    if (manage) {
        const actions = document.createElement('div');
        actions.className = 'xp-profile-actions';
        newButton = button('New');
        newButton.prepend(dialogIcon('plus', 15));
        renameButton = button('Rename');
        deleteButton = button('Delete', 'xp-profile-delete');
        newButton.addEventListener('click', () => openNameForm('create'));
        renameButton.addEventListener('click', () => openNameForm('rename'));
        deleteButton.addEventListener('click', openDeleteForm);
        actions.append(newButton, renameButton, deleteButton);
        row.append(actions);
    }
    element.append(status);
    const unsubscribe = client.subscribe(render);
    render();
    return {
        element,
        dispose() {
            if (disposed) return;
            disposed = true;
            clearTimeout(statusTimer);
            closeMenu();
            document.removeEventListener('pointerdown', clickAway, true);
            document.removeEventListener('focusin', focusAway, true);
            document.removeEventListener('scroll', positionMenu, true);
            window.removeEventListener('resize', positionMenu);
            window.visualViewport?.removeEventListener('resize', positionMenu);
            window.visualViewport?.removeEventListener('scroll', positionMenu);
            unsubscribe?.();
            element.remove();
        }
    };
}
