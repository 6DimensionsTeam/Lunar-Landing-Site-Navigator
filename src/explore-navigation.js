import './explore-navigation.css';

// Mount from P2 without changing the shared explore markup or its Back handler.
export function installExploreNavigation({ root, onReturn }) {
  const rover = root.querySelector('#torover');
  const actions = document.createElement('div');
  actions.className = 'rover-cta explore-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', 'Surface navigation');

  const button = document.createElement('button');
  button.id = 'return-moon';
  button.className = 'cta2';
  button.type = 'button';
  button.textContent = 'Return to Moon';
  button.title = 'Return to the Moon overview';
  button.addEventListener('click', onReturn);

  rover.replaceWith(actions);
  rover.classList.remove('rover-cta');
  actions.append(button, rover);
  return button;
}
