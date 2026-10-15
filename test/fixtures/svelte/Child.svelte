<script>
  import { getI18nContext } from '@nordbeam/locale/svelte';

  const { locale, messages } = getI18nContext();
</script>

<p lang={$locale}>{$messages.greeting({ name: 'Ada' })} / {$messages.items({ count: 2 })}</p>
