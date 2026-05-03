// Per-component import — the eslint barrel rule requires this form.
import { Button } from '@tale-ui/react/button';

export function App() {
  return (
    <>
      <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600 }}>Hello Bento</h1>
      <Button variant="primary">Click me</Button>
    </>
  );
}
