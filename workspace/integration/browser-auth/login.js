const form = document.getElementById('login-form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  const error = document.getElementById('login-error');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json', 'X-Juanca-Request': '1'},
      body: JSON.stringify({username: form.elements.username.value, password: form.elements.password.value, remember: form.elements.remember.checked})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível entrar.');
    form.elements.password.value = '';
    window.location.replace('/');
  } catch (exception) {
    error.textContent = exception instanceof TypeError ? 'Não foi possível conectar ao Juanca. Verifique a conexão e o Tailscale.' : exception.message;
  } finally { button.disabled = false; }
});
