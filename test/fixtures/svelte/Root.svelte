<script>
  import { createSvelteI18n, setI18nContext } from '@nordbeam/locale/svelte';
  import Child from './Child.svelte';

  let { initial, loadLocale } = $props();
  setI18nContext(createSvelteI18n({ initial, loadLocale }));
</script>

<main>
  <Child />
</main>
